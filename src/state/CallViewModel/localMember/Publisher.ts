/*
Copyright 2025 Element Creations Ltd.
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/
import {
  ConnectionState as LivekitConnectionState,
  type LocalTrack,
  type LocalTrackPublication,
  LocalVideoTrack,
  ParticipantEvent,
  type Room as LivekitRoom,
  Track,
} from "livekit-client";
import {
  filter,
  map,
  NEVER,
  pairwise,
  type Observable,
  type Subscription,
  switchMap,
} from "rxjs";
import { type Logger } from "matrix-js-sdk/lib/logger";

import type { Behavior } from "../../Behavior.ts";
import type {
  AudioOutputSession,
  MediaDevices,
  SelectedDevice,
} from "../../MediaDevices.ts";
import type { MuteStates } from "../../MuteStates.ts";
import {
  type ProcessorState,
  trackProcessorSync,
} from "../../../livekit/TrackProcessorContext.tsx";

import { observeTrackReference$ } from "../../observeTrackReference";
import { type Connection } from "../remoteMembers/Connection.ts";
import { ObservableScope } from "../../ObservableScope.ts";

const PUBLISHABLE_TRACK_SOURCES: Track.Source[] = [
  Track.Source.Microphone,
  Track.Source.Camera,
  Track.Source.ScreenShare,
  Track.Source.ScreenShareAudio,
];

/**
 * A wrapper for a Connection object.
 * This wrapper will manage the connection used to publish to the LiveKit room.
 * The Publisher is also responsible for creating the media tracks.
 */
export class Publisher {
  /**
   * By default, livekit will start publishing tracks as soon as they are created.
   * In the matrix RTC world, we want to control when tracks are published based
   * on whether the user is part of the RTC session or not.
   */
  public shouldPublish = false;

  private publishingRequested = false;
  private publishingReconcile: Promise<void> | undefined;
  private publishingTransitionNeedsRetry = false;
  private destroyed = false;

  private readonly scope = new ObservableScope();

  /** Tracks paused by this Publisher, so unrelated upstream pauses are preserved. */
  private readonly pausedUpstreams = new Set<LocalTrack>();
  private readonly upstreamOperations = new Map<LocalTrack, Promise<void>>();

  private readonly onLocalTrackPublished = (
    localTrackPublication: LocalTrackPublication,
  ): void => {
    this.handleLocalTrackPublished(localTrackPublication);
  };

  private readonly onLocalTrackUnpublished = (
    localTrackPublication: LocalTrackPublication,
  ): void => {
    if (this.destroyed) return;
    const track = localTrackPublication.track;
    if (!track) return;

    // Releasing ownership does not cancel an in-flight LiveKit operation. The
    // operation remains tracked until it settles, while current-publication
    // checks prevent any later resume of this retired track.
    this.pausedUpstreams.delete(track);
  };

  /**
   * Creates a new Publisher.
   * @param connection - The connection to use for publishing.
   * @param devices - The media devices to use for audio and video input.
   * @param muteStates - The mute states for audio and video.
   * @param trackerProcessorState$ - The processor state for the video track processor (e.g. background blur).
   * @param logger - The logger to use for logging :D.
   * @param controlledAudioDevices - Whether the app hosting Element Call
   *   controls the audio output devices, rather than the browser.
   */
  public constructor(
    private connection: Pick<Connection, "livekitRoom" | "state$">, //setE2EEEnabled,
    devices: MediaDevices,
    private readonly muteStates: MuteStates,
    trackerProcessorState$: Behavior<ProcessorState>,
    private logger: Logger,
    controlledAudioDevices: boolean,
  ) {
    const room = connection.livekitRoom;

    room.setE2EEEnabled(room.options.e2ee !== undefined)?.catch((e: Error) => {
      this.logger.error("Failed to set E2EE enabled on room", e);
    });

    // Setup track processor syncing (blur)
    this.observeTrackProcessors(this.scope, room, trackerProcessorState$);
    // Observe media device changes and update LiveKit active devices accordingly
    this.observeMediaDevices(this.scope, devices, controlledAudioDevices);
    this.observeAudioOutputSession(devices.audioOutputSession);

    this.workaroundRestartAudioInputTrackChrome(devices, this.scope);

    const localParticipant = this.connection.livekitRoom.localParticipant;
    localParticipant.on(
      ParticipantEvent.LocalTrackPublished,
      this.onLocalTrackPublished,
    );
    localParticipant.on(
      ParticipantEvent.LocalTrackUnpublished,
      this.onLocalTrackUnpublished,
    );
  }

  public async destroy(): Promise<void> {
    this.destroyed = true;
    this.publishingRequested = false;
    this.shouldPublish = false;
    const localParticipant = this.connection.livekitRoom.localParticipant;
    localParticipant.off(
      ParticipantEvent.LocalTrackPublished,
      this.onLocalTrackPublished,
    );
    localParticipant.off(
      ParticipantEvent.LocalTrackUnpublished,
      this.onLocalTrackUnpublished,
    );
    this.pausedUpstreams.clear();
    this.scope.end();
    this.logger.info("Scope ended -> unset handler");
    this.muteStates.audio.unsetHandler();
    this.muteStates.video.unsetHandler();

    this.logger.info(`Start to stop tracks`);
    try {
      await this.stopTracks();
      this.logger.info(`Done to stop tracks`);
    } catch (e) {
      this.logger.error(`Failed to stop tracks: ${e}`);
    }
  }

  // LiveKit will publish the tracks as soon as they are created
  // but we want to control when tracks are published.
  // We cannot just mute the tracks, even if this will effectively stop the publishing,
  // it would also prevent the user from seeing their own video/audio preview.
  // So for that we use pauseUpStream():  Stops sending media to the server by replacing
  // the sender track with null, but keeps the local MediaStreamTrack active.
  // The user can still see/hear themselves locally, but remote participants see nothing.
  private handleLocalTrackPublished(
    localTrackPublication: LocalTrackPublication,
  ): void {
    if (this.destroyed) return;
    this.logger.info("Local track published", localTrackPublication);
    const lkRoom = this.connection.livekitRoom;
    if (!this.publishingRequested || !this.shouldPublish) {
      this.logger.debug("Not publishing, pausing upstream");
      this.pauseUpstreams(lkRoom, [localTrackPublication.source]).catch((e) => {
        this.publishingTransitionNeedsRetry = true;
        this.logger.error(`Failed to pause upstreams`, e);
      });
    }
    if (localTrackPublication.source === Track.Source.Microphone) {
      const muteState = this.muteStates.audio;
      // skip this if a sync is in progress: enabled$ still reflects the old
      // state while the handler is mid-flight, so the handler itself will apply
      // the correct mute state once it completes.
      if (!muteState.syncing$.value) {
        const enabled = muteState.enabled$.value;
        if (!enabled) {
          this.logger.info(
            "Local audio track just published but muted meanwhile, setting enabled to false",
          );
          lkRoom.localParticipant.setMicrophoneEnabled(false).catch((e) => {
            this.logger.error(
              `Failed to enable microphone track, enabled:${enabled}`,
              e,
            );
          });
        }
      }
    } else if (localTrackPublication.source === Track.Source.Camera) {
      const muteState = this.muteStates.video;
      // skip this if a sync is in progress: enabled$ still reflects the old
      // state while the handler is mid-flight, so the handler itself will apply
      // the correct mute state once it completes.
      if (!muteState.syncing$.value) {
        const enabled = muteState.enabled$.value;
        if (!enabled) {
          this.logger.info(
            "Local video track just published but muted meanwhile, setting enabled to false",
          );
          lkRoom.localParticipant.setCameraEnabled(false).catch((e) => {
            this.logger.error(
              `Failed to enable camera track, enabled:${enabled}`,
              e,
            );
          });
        }
      }
    }
  }
  /**
   * Create and setup local audio and video tracks based on the current mute states.
   * It creates the tracks only if audio and/or video is enabled, to avoid unnecessary
   * permission prompts.
   *
   * It also observes mute state changes to update LiveKit microphone/camera states accordingly.
   * If a track is not created initially because disabled, it will be created when unmuting.
   *
   * This call is not blocking anymore, instead callers can listen to the
   * `RoomEvent.MediaDevicesError` event in the LiveKit room to be notified of any errors.
   *
   */
  public async createAndSetupTracks(): Promise<void> {
    this.logger.debug("createAndSetupTracks called");
    const lkRoom = this.connection.livekitRoom;
    // Observe mute state changes and update LiveKit microphone/camera states accordingly
    this.observeMuteStates();

    // Check if audio and/or video is enabled. We only create tracks if enabled,
    // because it could prompt for permission, and we don't want to do that unnecessarily.
    const audio = this.muteStates.audio.enabled$.value;
    const video = this.muteStates.video.enabled$.value;

    // We don't await the creation, because livekit could block until the tracks
    // are fully published, and not only that they are created.
    // We don't have control on that, localParticipant creates and publishes the tracks
    // asap.
    // We are using the `ParticipantEvent.LocalTrackPublished` to be notified
    // when tracks are actually published, and at that point
    // we can pause upstream if needed (depending on if startPublishing has been called).
    if (audio && video) {
      // Enable both at once in order to have a single permission prompt!
      void lkRoom.localParticipant.enableCameraAndMicrophone();
    } else if (audio) {
      void lkRoom.localParticipant.setMicrophoneEnabled(true);
    } else if (video) {
      void lkRoom.localParticipant.setCameraEnabled(true);
    }

    return Promise.resolve();
  }

  private async pauseUpstreams(
    lkRoom: LivekitRoom,
    sources: Track.Source[],
  ): Promise<void> {
    let firstError: unknown;
    for (const source of sources) {
      if (this.destroyed) break;
      const track = lkRoom.localParticipant.getTrackPublication(source)?.track;
      if (!track) {
        this.logger.warn(
          `No track found for source ${source} to pause upstream`,
        );
        continue;
      }
      try {
        await this.pauseUpstream(track);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  }

  private async pauseUpstream(track: LocalTrack): Promise<void> {
    if (this.destroyed || !this.isCurrentTrack(track)) return;
    const pendingOperation = this.upstreamOperations.get(track);
    if (pendingOperation) {
      await pendingOperation;
      if (this.destroyed || !this.isCurrentTrack(track)) return;
      if (!track.isUpstreamPaused) return this.pauseUpstream(track);
      return;
    }
    if (this.destroyed || !this.isCurrentTrack(track)) return;
    // A paused track may belong to another owner. Only resume tracks that this
    // Publisher paused itself while reconciling its publishing state.
    if (track.isUpstreamPaused) return;

    this.pausedUpstreams.add(track);
    const operation = track.pauseUpstream().then(
      () => undefined,
      (error: unknown) => {
        // Retain ownership so the same desired state can retry this track.
        throw error;
      },
    );
    this.upstreamOperations.set(track, operation);
    void operation.then(
      () => this.clearUpstreamOperation(track, operation),
      () => this.clearUpstreamOperation(track, operation),
    );
    await operation;
  }

  private async resumeUpstreams(
    lkRoom: LivekitRoom,
    sources: Track.Source[],
  ): Promise<void> {
    let firstError: unknown;
    const attemptedTracks = new Set<LocalTrack>();
    const resume = async (track: LocalTrack): Promise<void> => {
      attemptedTracks.add(track);
      try {
        await this.resumeUpstream(track);
      } catch (error) {
        firstError ??= error;
      }
    };

    for (const source of sources) {
      const track = lkRoom.localParticipant.getTrackPublication(source)?.track;
      if (track) {
        await resume(track);
      } else {
        this.logger.warn(
          `No track found for source ${source} to resume upstream`,
        );
      }
    }

    // A publication may arrive while one of the source operations is awaiting
    // LiveKit. It is already owned by this Publisher, so converge on it before
    // declaring the publishing transition complete. Do not immediately retry a
    // failed track; a later same-state request will retry it.
    while (!this.destroyed && this.publishingRequested) {
      const pendingTracks = [...this.pausedUpstreams].filter((track) => {
        if (!this.isCurrentTrack(track)) {
          this.pausedUpstreams.delete(track);
          return false;
        }
        return !attemptedTracks.has(track);
      });
      if (pendingTracks.length === 0) break;
      for (const track of pendingTracks) await resume(track);
    }
    if (firstError) throw firstError;
  }

  private async resumeUpstream(track: LocalTrack): Promise<void> {
    await this.upstreamOperations.get(track);
    if (
      this.destroyed ||
      !this.publishingRequested ||
      !this.pausedUpstreams.has(track) ||
      !this.isCurrentTrack(track)
    )
      return;

    const operation = track.resumeUpstream().then(
      () => {
        this.pausedUpstreams.delete(track);
      },
      (error: unknown) => {
        throw error;
      },
    );
    this.upstreamOperations.set(track, operation);
    void operation.then(
      () => this.clearUpstreamOperation(track, operation),
      () => this.clearUpstreamOperation(track, operation),
    );
    await operation;
    if (this.destroyed || !this.isCurrentTrack(track)) return;
    if (!this.publishingRequested && !track.isUpstreamPaused)
      await this.pauseUpstream(track);
  }

  private clearUpstreamOperation(
    track: LocalTrack,
    operation: Promise<void>,
  ): void {
    if (this.upstreamOperations.get(track) === operation)
      this.upstreamOperations.delete(track);
  }

  private isCurrentTrack(track: LocalTrack): boolean {
    return (
      this.connection.livekitRoom.localParticipant.getTrackPublication(
        track.source,
      )?.track === track
    );
  }

  /** Reconcile the effective MatrixRTC publishing condition. */
  public async setPublishingEnabled(enabled: boolean): Promise<void> {
    if (this.destroyed) return;
    this.publishingRequested = enabled;
    if (this.publishingReconcile) return this.publishingReconcile;

    this.publishingReconcile = this.reconcilePublishing().finally(() => {
      this.publishingReconcile = undefined;
    });
    return this.publishingReconcile;
  }

  public async startPublishing(): Promise<void> {
    await this.setPublishingEnabled(true);
  }

  public async stopPublishing(): Promise<void> {
    await this.setPublishingEnabled(false);
  }

  private async reconcilePublishing(): Promise<void> {
    while (true) {
      if (this.destroyed) return;
      const requested = this.publishingRequested;
      if (
        requested === this.shouldPublish &&
        !this.publishingTransitionNeedsRetry
      )
        return;
      this.publishingTransitionNeedsRetry = false;

      if (requested) {
        await this.startPublishingNow();
      } else {
        await this.stopPublishingNow();
      }
      if (this.publishingTransitionNeedsRetry) return;
    }
  }

  private async startPublishingNow(): Promise<void> {
    this.logger.debug("startPublishing called");

    // Resume upstream for tracks this Publisher paused. We need to call it
    // explicitly because setTrackEnabled does not always resume upstream.
    try {
      await this.resumeUpstreams(
        this.connection.livekitRoom,
        PUBLISHABLE_TRACK_SOURCES,
      );
    } catch (e) {
      this.publishingTransitionNeedsRetry = true;
      this.logger.error(`Failed to resume upstreams`, e);
    }

    // Do not publish after a disconnect raced the asynchronous resume.
    if (this.publishingRequested && !this.destroyed) this.shouldPublish = true;
  }

  private async stopPublishingNow(): Promise<void> {
    this.logger.debug("stopPublishing called");
    this.shouldPublish = false;
    // Pause upstream will stop sending media to the server, while keeping
    // the local MediaStreamTrack active, so the user can still see themselves.
    try {
      await this.pauseUpstreams(
        this.connection.livekitRoom,
        PUBLISHABLE_TRACK_SOURCES,
      );
    } catch (error) {
      this.publishingTransitionNeedsRetry = true;
      throw error;
    }
  }

  public async stopTracks(): Promise<void> {
    const lkRoom = this.connection.livekitRoom;
    for (const source of PUBLISHABLE_TRACK_SOURCES) {
      const localPub = lkRoom.localParticipant.getTrackPublication(source);
      if (localPub?.track) {
        // stops and unpublishes the track
        await lkRoom.localParticipant.unpublishTrack(localPub!.track, true);
      }
    }
  }

  /// Private methods

  // Restart the audio input track whenever we detect that the active media
  // device has changed to refer to a different hardware device. We do this
  // for the sake of Chrome, which provides a "default" device that is meant
  // to match the system's default audio input, whatever that may be.
  // This is special-cased for only audio inputs because we need to dig around
  // in the LocalParticipant object for the track object and there's not a nice
  // way to do that generically. There is usually no OS-level default video capture
  // device anyway, and audio outputs work differently.
  private workaroundRestartAudioInputTrackChrome(
    devices: MediaDevices,
    scope: ObservableScope,
  ): void {
    const lkRoom = this.connection.livekitRoom;
    devices.audioInput.selected$
      .pipe(
        switchMap((device) => device?.hardwareDeviceChange$ ?? NEVER),
        scope.bind(),
      )
      .subscribe(() => {
        if (lkRoom.state != LivekitConnectionState.Connected) return;
        const activeMicTrack = Array.from(
          lkRoom.localParticipant.audioTrackPublications.values(),
        ).find((d) => d.source === Track.Source.Microphone)?.track;

        if (
          activeMicTrack &&
          // only restart if the stream is still running: LiveKit will detect
          // when a track stops & restart appropriately, so this is not our job.
          // Plus, we need to avoid restarting again if the track is already in
          // the process of being restarted.
          activeMicTrack.mediaStreamTrack.readyState !== "ended"
        ) {
          this.logger?.info(
            "Restarting audio device track due to active media device changed (workaroundRestartAudioInputTrackChrome)",
          );
          // Restart the track, which will cause Livekit to do another
          // getUserMedia() call with deviceId: default to get the *new* default device.
          // Note that room.switchActiveDevice() won't work: Livekit will ignore it because
          // the deviceId hasn't changed (was & still is default).
          lkRoom.localParticipant
            .getTrackPublication(Track.Source.Microphone)
            ?.audioTrack?.restartTrack()
            .catch((e) => {
              this.logger.error(`Failed to restart audio device track`, e);
            });
        }
      });
  }

  // Reapply the native output route after enabling the microphone recreates the audio session.
  private observeAudioOutputSession(
    audioOutputSession: AudioOutputSession | undefined,
  ): void {
    if (audioOutputSession === undefined) return;

    this.muteStates.audio.enabled$
      .pipe(
        pairwise(),
        filter(([wasEnabled, enabled]) => !wasEnabled && enabled),
        this.scope.bind(),
      )
      .subscribe(() => audioOutputSession.reapplySelection());
  }

  // Observe changes in the selected media devices and update the LiveKit room accordingly.
  private observeMediaDevices(
    scope: ObservableScope,
    devices: MediaDevices,
    controlledAudioDevices: boolean,
  ): void {
    const lkRoom = this.connection.livekitRoom;
    const syncDevice = (
      kind: MediaDeviceKind,
      selected$: Observable<SelectedDevice | undefined>,
    ): Subscription =>
      selected$.pipe(scope.bind()).subscribe((device) => {
        if (lkRoom.state != LivekitConnectionState.Connected) return;
        // if (this.connectionState$.value !== ConnectionState.Connected) return;
        this.logger.info(
          "[LivekitRoom] syncDevice room.getActiveDevice(kind) !== d.id :",
          lkRoom.getActiveDevice(kind),
          " !== ",
          device?.id,
        );
        if (
          device !== undefined &&
          lkRoom.getActiveDevice(kind) !== device.id
        ) {
          lkRoom
            .switchActiveDevice(kind, device.id)
            .catch((e: Error) =>
              this.logger.error(
                `Failed to sync ${kind} device with LiveKit`,
                e,
              ),
            );
        }
      });

    syncDevice("audioinput", devices.audioInput.selected$);
    if (!controlledAudioDevices)
      syncDevice("audiooutput", devices.audioOutput.selected$);
    syncDevice("videoinput", devices.videoInput.selected$);
  }

  /**
   * Observe changes in the mute states and update the LiveKit room accordingly.
   * @private
   */
  private observeMuteStates(): void {
    const lkRoom = this.connection.livekitRoom;
    this.muteStates.audio.setHandler(async (enable) => {
      try {
        this.logger.debug(
          `handler: Setting LiveKit microphone enabled: ${enable}`,
        );
        await lkRoom.localParticipant.setMicrophoneEnabled(enable);
        // Unmute will restart the track if it was paused upstream,
        // but until explicitly requested, we want to keep it paused.
        if (!this.shouldPublish && enable) {
          await this.pauseUpstreams(lkRoom, [Track.Source.Microphone]);
        }
        return enable;
      } catch (e) {
        this.logger.error("Failed to update LiveKit audio input mute state", e);
        return lkRoom.localParticipant.isMicrophoneEnabled;
      }
    });
    this.muteStates.video.setHandler(async (enable) => {
      try {
        this.logger.debug(`handler: Setting LiveKit camera enabled: ${enable}`);
        await lkRoom.localParticipant.setCameraEnabled(enable);
        // Unmute will restart the track if it was paused upstream,
        // but until explicitly requested, we want to keep it paused.
        if (!this.shouldPublish && enable) {
          await this.pauseUpstreams(lkRoom, [Track.Source.Camera]);
        }
        return enable;
      } catch (e) {
        this.logger.error("Failed to update LiveKit video input mute state", e);
        return lkRoom.localParticipant.isCameraEnabled;
      }
    });
  }

  private observeTrackProcessors(
    scope: ObservableScope,
    room: LivekitRoom,
    trackerProcessorState$: Behavior<ProcessorState>,
  ): void {
    const track$ = scope.behavior(
      observeTrackReference$(room.localParticipant, Track.Source.Camera).pipe(
        map((trackRef) => {
          const track = trackRef?.publication.track;
          return track instanceof LocalVideoTrack ? track : null;
        }),
      ),
      null,
    );
    trackProcessorSync(scope, track$, trackerProcessorState$);
  }
}
