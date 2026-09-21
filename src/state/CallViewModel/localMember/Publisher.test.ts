/*
Copyright 2025 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import {
  ConnectionState as LivekitConnectionState,
  LocalParticipant,
  type LocalTrack,
  type LocalTrackPublication,
  ParticipantEvent,
  Track,
} from "livekit-client";
import { BehaviorSubject } from "rxjs";
import { logger } from "matrix-js-sdk/lib/logger";

import { ObservableScope } from "../../ObservableScope";
import { constant } from "../../Behavior";
import {
  flushPromises,
  mockLivekitRoom,
  mockMediaDevices,
} from "../../../utils/test";
import { Publisher } from "./Publisher";
import { type Connection } from "../remoteMembers/Connection";
import { type MuteStates } from "../../MuteStates";

let scope: ObservableScope;

beforeEach(() => {
  scope = new ObservableScope();
});

afterEach(() => scope.end());

function createMockLocalTrack(source: Track.Source): LocalTrack {
  const track = {
    source,
    isMuted: false,
    isUpstreamPaused: false,
  } as Partial<LocalTrack> as LocalTrack;

  vi.mocked(track).mute = vi.fn().mockImplementation(() => {
    track.isMuted = true;
  });
  vi.mocked(track).unmute = vi.fn().mockImplementation(() => {
    track.isMuted = false;
  });
  vi.mocked(track).pauseUpstream = vi.fn().mockImplementation(async () => {
    // @ts-expect-error - for that test we want to set isUpstreamPaused directly
    track.isUpstreamPaused = true;
    await Promise.resolve();
  });
  vi.mocked(track).resumeUpstream = vi.fn().mockImplementation(async () => {
    // @ts-expect-error - for that test we want to set isUpstreamPaused directly
    track.isUpstreamPaused = false;
    await Promise.resolve();
  });

  return track;
}

function createMockMuteState(enabled$: BehaviorSubject<boolean>): {
  enabled$: BehaviorSubject<boolean>;
  syncing$: BehaviorSubject<boolean>;
  setHandler: (h: (enabled: boolean) => void) => void;
  unsetHandler: () => void;
} {
  let currentHandler = (enabled: boolean): void => {};

  const ms = {
    enabled$,
    syncing$: new BehaviorSubject(false),
    setHandler: vi.fn().mockImplementation((h: (enabled: boolean) => void) => {
      currentHandler = h;
    }),
    unsetHandler: vi.fn().mockImplementation(() => {
      currentHandler = (enabled: boolean): void => {};
    }),
  };
  enabled$.subscribe((enabled) => {
    logger.info(`MockMuteState: enabled changed to ${enabled}`);
    currentHandler(enabled);
  });

  return ms;
}

let connection: Connection;
let muteStates: MuteStates;
let localParticipant: LocalParticipant;
let audioEnabled$: BehaviorSubject<boolean>;
let videoEnabled$: BehaviorSubject<boolean>;
let trackPublications: LocalTrackPublication[];
let createTrackLock: Promise<void>;
const reapplyAudioOutputSelection = vi.fn();

beforeEach(() => {
  trackPublications = [];
  audioEnabled$ = new BehaviorSubject(false);
  videoEnabled$ = new BehaviorSubject(false);
  createTrackLock = Promise.resolve();

  muteStates = {
    audio: createMockMuteState(audioEnabled$),
    video: createMockMuteState(videoEnabled$),
  } as unknown as MuteStates;

  const mockSendDataPacket = vi.fn();
  const mockEngine = {
    client: {
      sendUpdateLocalMetadata: vi.fn(),
    },
    on: vi.fn().mockReturnThis(),
    sendDataPacket: mockSendDataPacket,
  };

  localParticipant = new LocalParticipant(
    "local-sid",
    "local-identity",
    // @ts-expect-error - for that test we want a real LocalParticipant to have the pending publications logic
    mockEngine,
    {
      adaptiveStream: true,
      dynacase: false,
      audioCaptureDefaults: {},
      videoCaptureDefaults: {},
      stopLocalTrackOnUnpublish: true,
      reconnectPolicy: "always",
      disconnectOnPageLeave: true,
    },
    new Map(),
    {},
    {},
    {},
  );

  vi.mocked(localParticipant).createTracks = vi
    .fn()
    .mockImplementation(async (opts) => {
      const tracks: LocalTrack[] = [];
      if (opts.audio) {
        tracks.push(createMockLocalTrack(Track.Source.Microphone));
      }
      if (opts.video) {
        tracks.push(createMockLocalTrack(Track.Source.Camera));
      }
      await createTrackLock;
      return tracks;
    });

  vi.mocked(localParticipant).publishTrack = vi
    .fn()
    .mockImplementation(async (track: LocalTrack) => {
      const pub = {
        track,
        source: track.source,
        mute: track.mute,
        unmute: track.unmute,
      } as Partial<LocalTrackPublication> as LocalTrackPublication;
      trackPublications.push(pub);
      localParticipant.emit(ParticipantEvent.LocalTrackPublished, pub);
      return Promise.resolve(pub);
    });

  vi.mocked(localParticipant).getTrackPublication = vi
    .fn()
    .mockImplementation((source: Track.Source) => {
      return trackPublications.find((pub) => pub.track?.source === source);
    });

  vi.mocked(localParticipant).unpublishTrack = vi
    .fn()
    .mockImplementation(async (track: LocalTrack) => {
      const index = trackPublications.findIndex((pub) => pub.track === track);
      if (index < 0) {
        await Promise.resolve();
        return undefined;
      }
      const [publication] = trackPublications.splice(index, 1);
      localParticipant.emit(
        ParticipantEvent.LocalTrackUnpublished,
        publication,
      );
      await Promise.resolve();
      return publication;
    });

  connection = {
    state$: constant({
      state: "ConnectedToLkRoom",
      livekitConnectionState$: constant(LivekitConnectionState.Connected),
    }),
    livekitRoom: mockLivekitRoom({
      localParticipant: localParticipant,
    }),
  } as unknown as Connection;
});

describe("Publisher", () => {
  let publisher: Publisher;

  beforeEach(() => {
    reapplyAudioOutputSelection.mockReset();
    publisher = new Publisher(
      connection,
      mockMediaDevices({
        audioOutputSession: {
          reapplySelection: reapplyAudioOutputSelection,
        },
      }),
      muteStates,
      constant({ supported: false, processor: undefined }),
      logger,
      false,
    );
  });

  afterEach(async () => {
    await publisher.destroy();
  });

  it("reapplies the native output route when the microphone is enabled", () => {
    audioEnabled$.next(true);

    expect(reapplyAudioOutputSelection).toHaveBeenCalledOnce();
  });

  it("Should not create tracks if started muted to avoid unneeded permission requests", async () => {
    const createTracksSpy = vi.spyOn(
      connection.livekitRoom.localParticipant,
      "createTracks",
    );

    audioEnabled$.next(false);
    videoEnabled$.next(false);
    await publisher.createAndSetupTracks();

    expect(createTracksSpy).not.toHaveBeenCalled();
  });

  it("should unsetHandler and stop tracks on destroy", async () => {
    const unsetVideoSpy = vi.spyOn(
      (
        publisher as unknown as {
          muteStates: { video: { unsetHandler: () => void } };
        }
      ).muteStates.video,
      "unsetHandler",
    );
    const unsetAudioSpy = vi.spyOn(
      (
        publisher as unknown as {
          muteStates: { audio: { unsetHandler: () => void } };
        }
      ).muteStates.audio,
      "unsetHandler",
    );
    const scopeEndSpy = vi.spyOn(
      (publisher as unknown as { scope: { end: () => void } }).scope,
      "end",
    );
    const stopTracksSpy = vi.spyOn(publisher, "stopTracks");
    await publisher.destroy();

    expect(stopTracksSpy).toHaveBeenCalledOnce();
    expect(unsetVideoSpy).toHaveBeenCalledOnce();
    expect(unsetAudioSpy).toHaveBeenCalledOnce();
    expect(scopeEndSpy).toHaveBeenCalled();
  });

  it("Should minimize permission request by querying create at once", async () => {
    const enableCameraAndMicrophoneSpy = vi.spyOn(
      localParticipant,
      "enableCameraAndMicrophone",
    );
    const createTracksSpy = vi.spyOn(localParticipant, "createTracks");

    audioEnabled$.next(true);
    videoEnabled$.next(true);
    await publisher.createAndSetupTracks();
    await flushPromises();

    expect(enableCameraAndMicrophoneSpy).toHaveBeenCalled();
    expect(createTracksSpy).toHaveBeenCalledWith({
      audio: true,
      video: true,
    });
  });

  it("Ensure no data is streamed until publish has been called", async () => {
    audioEnabled$.next(true);
    await publisher.createAndSetupTracks();

    expect(localParticipant.createTracks).toHaveBeenCalledWith({
      audio: true,
      video: undefined,
    });
    await flushPromises();
    expect(localParticipant.publishTrack).toHaveBeenCalled();

    await flushPromises();
    const track = localParticipant.getTrackPublication(
      Track.Source.Microphone,
    )?.track;
    expect(track).toBeDefined();
    expect(track!.pauseUpstream).toHaveBeenCalled();
    expect(track!.isUpstreamPaused).toBe(true);
  });

  it("Ensure resume upstream when published is called", async () => {
    videoEnabled$.next(true);
    await publisher.createAndSetupTracks();
    await publisher.startPublishing();

    const track = localParticipant.getTrackPublication(
      Track.Source.Camera,
    )?.track;
    expect(track).toBeDefined();
    expect(track!.isUpstreamPaused).toBe(false);
  });

  it("resumes a microphone published while awaiting another track", async () => {
    const microphone = createMockLocalTrack(Track.Source.Microphone);
    const camera = createMockLocalTrack(Track.Source.Camera);
    trackPublications.push(
      {
        track: microphone,
        source: Track.Source.Microphone,
        mute: microphone.mute,
        unmute: microphone.unmute,
      } as Partial<LocalTrackPublication> as LocalTrackPublication,
      {
        track: camera,
        source: Track.Source.Camera,
        mute: camera.mute,
        unmute: camera.unmute,
      } as Partial<LocalTrackPublication> as LocalTrackPublication,
    );
    await publisher.startPublishing();
    await publisher.stopPublishing();

    const cameraResume = Promise.withResolvers<void>();
    vi.mocked(camera.resumeUpstream).mockImplementationOnce(async () => {
      // @ts-expect-error - for that test we want to set isUpstreamPaused directly
      camera.isUpstreamPaused = false;
      await cameraResume.promise;
    });
    const start = publisher.startPublishing();
    await flushPromises();
    expect(camera.resumeUpstream).toHaveBeenCalledOnce();

    await localParticipant.unpublishTrack(microphone);
    const replacementMicrophone = createMockLocalTrack(Track.Source.Microphone);
    const replacementPublication = {
      track: replacementMicrophone,
      source: Track.Source.Microphone,
      mute: replacementMicrophone.mute,
      unmute: replacementMicrophone.unmute,
    } as Partial<LocalTrackPublication> as LocalTrackPublication;
    trackPublications.unshift(replacementPublication);
    localParticipant.emit(
      ParticipantEvent.LocalTrackPublished,
      replacementPublication,
    );
    await flushPromises();
    expect(replacementMicrophone.isUpstreamPaused).toBe(true);

    cameraResume.resolve();
    await start;

    expect(replacementMicrophone.resumeUpstream).toHaveBeenCalledOnce();
    expect(replacementMicrophone.isUpstreamPaused).toBe(false);
  });

  it("does not resume a track after it is unpublished", async () => {
    const track = createMockLocalTrack(Track.Source.Camera);
    const publication = {
      track,
      source: track.source,
      mute: track.mute,
      unmute: track.unmute,
    } as Partial<LocalTrackPublication> as LocalTrackPublication;
    trackPublications.push(publication);

    await publisher.startPublishing();
    await publisher.stopPublishing();
    await localParticipant.unpublishTrack(track);
    await publisher.startPublishing();

    expect(track.pauseUpstream).toHaveBeenCalledOnce();
    expect(track.resumeUpstream).not.toHaveBeenCalled();
  });

  it("resumes an owned current replacement but not its retired publication", async () => {
    const retiredTrack = createMockLocalTrack(Track.Source.Microphone);
    const retiredPublication = {
      track: retiredTrack,
      source: retiredTrack.source,
      mute: retiredTrack.mute,
      unmute: retiredTrack.unmute,
    } as Partial<LocalTrackPublication> as LocalTrackPublication;
    trackPublications.push(retiredPublication);

    await publisher.startPublishing();
    await publisher.stopPublishing();
    await localParticipant.unpublishTrack(retiredTrack);

    const replacementTrack = createMockLocalTrack(Track.Source.Microphone);
    const replacementPublication = {
      track: replacementTrack,
      source: replacementTrack.source,
      mute: replacementTrack.mute,
      unmute: replacementTrack.unmute,
    } as Partial<LocalTrackPublication> as LocalTrackPublication;
    trackPublications.unshift(replacementPublication);
    localParticipant.emit(
      ParticipantEvent.LocalTrackPublished,
      replacementPublication,
    );
    await flushPromises();

    await publisher.startPublishing();

    expect(retiredTrack.resumeUpstream).not.toHaveBeenCalled();
    expect(replacementTrack.resumeUpstream).toHaveBeenCalledOnce();
    expect(replacementTrack.isUpstreamPaused).toBe(false);
  });

  it("does not resume an unpublished replacement while another track resumes", async () => {
    const microphone = createMockLocalTrack(Track.Source.Microphone);
    const camera = createMockLocalTrack(Track.Source.Camera);
    trackPublications.push(
      {
        track: microphone,
        source: microphone.source,
        mute: microphone.mute,
        unmute: microphone.unmute,
      } as Partial<LocalTrackPublication> as LocalTrackPublication,
      {
        track: camera,
        source: camera.source,
        mute: camera.mute,
        unmute: camera.unmute,
      } as Partial<LocalTrackPublication> as LocalTrackPublication,
    );
    await publisher.startPublishing();
    await publisher.stopPublishing();

    const cameraResume = Promise.withResolvers<void>();
    vi.mocked(camera.resumeUpstream).mockImplementationOnce(async () => {
      // @ts-expect-error - for that test we want to set isUpstreamPaused directly
      camera.isUpstreamPaused = false;
      await cameraResume.promise;
    });
    const start = publisher.startPublishing();
    await flushPromises();
    expect(camera.resumeUpstream).toHaveBeenCalledOnce();

    await localParticipant.unpublishTrack(microphone);
    const replacement = createMockLocalTrack(Track.Source.Microphone);
    const replacementPublication = {
      track: replacement,
      source: replacement.source,
      mute: replacement.mute,
      unmute: replacement.unmute,
    } as Partial<LocalTrackPublication> as LocalTrackPublication;
    trackPublications.unshift(replacementPublication);
    localParticipant.emit(
      ParticipantEvent.LocalTrackPublished,
      replacementPublication,
    );
    await flushPromises();
    expect(replacement.isUpstreamPaused).toBe(true);

    await localParticipant.unpublishTrack(replacement);
    cameraResume.resolve();
    await start;

    expect(replacement.resumeUpstream).not.toHaveBeenCalled();
  });

  it("removes both publication listeners on destroy", async () => {
    await publisher.destroy();
    const onSpy = vi.spyOn(localParticipant, "on");
    const offSpy = vi.spyOn(localParticipant, "off");
    const replacementPublisher = new Publisher(
      connection,
      mockMediaDevices({}),
      muteStates,
      constant({ supported: false, processor: undefined }),
      logger,
      false,
    );

    const publishedOnCall = onSpy.mock.calls.find(
      ([event]) => event === ParticipantEvent.LocalTrackPublished,
    );
    const unpublishedOnCall = onSpy.mock.calls.find(
      ([event]) => event === ParticipantEvent.LocalTrackUnpublished,
    );
    expect(publishedOnCall).toBeDefined();
    expect(unpublishedOnCall).toBeDefined();

    await replacementPublisher.destroy();

    expect(offSpy).toHaveBeenCalledWith(
      ParticipantEvent.LocalTrackPublished,
      publishedOnCall![1],
    );
    expect(offSpy).toHaveBeenCalledWith(
      ParticipantEvent.LocalTrackUnpublished,
      unpublishedOnCall![1],
    );

    const track = createMockLocalTrack(Track.Source.Camera);
    const publication = {
      track,
      source: track.source,
    } as LocalTrackPublication;
    localParticipant.emit(ParticipantEvent.LocalTrackPublished, publication);
    localParticipant.emit(ParticipantEvent.LocalTrackUnpublished, publication);
    await flushPromises();
    expect(track.pauseUpstream).not.toHaveBeenCalled();
  });

  it("continues pausing tracks after one pause fails and retries the failed track", async () => {
    const microphone = createMockLocalTrack(Track.Source.Microphone);
    const camera = createMockLocalTrack(Track.Source.Camera);
    const screen = createMockLocalTrack(Track.Source.ScreenShare);
    trackPublications.push(
      {
        track: microphone,
        source: Track.Source.Microphone,
        mute: microphone.mute,
        unmute: microphone.unmute,
      } as Partial<LocalTrackPublication> as LocalTrackPublication,
      {
        track: camera,
        source: Track.Source.Camera,
        mute: camera.mute,
        unmute: camera.unmute,
      } as Partial<LocalTrackPublication> as LocalTrackPublication,
      {
        track: screen,
        source: Track.Source.ScreenShare,
        mute: screen.mute,
        unmute: screen.unmute,
      } as Partial<LocalTrackPublication> as LocalTrackPublication,
    );
    await publisher.startPublishing();
    vi.mocked(microphone.pauseUpstream).mockRejectedValueOnce(
      new Error("mic pause failed"),
    );

    await expect(publisher.stopPublishing()).rejects.toThrow(
      "mic pause failed",
    );
    expect(microphone.pauseUpstream).toHaveBeenCalledOnce();
    expect(camera.pauseUpstream).toHaveBeenCalledOnce();
    expect(screen.pauseUpstream).toHaveBeenCalledOnce();
    expect(camera.isUpstreamPaused).toBe(true);
    expect(screen.isUpstreamPaused).toBe(true);

    await publisher.stopPublishing();
    expect(microphone.pauseUpstream).toHaveBeenCalledTimes(2);
    expect(microphone.isUpstreamPaused).toBe(true);
  });

  it("continues resuming tracks after one resume fails and retries the failed track", async () => {
    const microphone = createMockLocalTrack(Track.Source.Microphone);
    const camera = createMockLocalTrack(Track.Source.Camera);
    const screen = createMockLocalTrack(Track.Source.ScreenShare);
    trackPublications.push(
      {
        track: microphone,
        source: Track.Source.Microphone,
        mute: microphone.mute,
        unmute: microphone.unmute,
      } as Partial<LocalTrackPublication> as LocalTrackPublication,
      {
        track: camera,
        source: Track.Source.Camera,
        mute: camera.mute,
        unmute: camera.unmute,
      } as Partial<LocalTrackPublication> as LocalTrackPublication,
      {
        track: screen,
        source: Track.Source.ScreenShare,
        mute: screen.mute,
        unmute: screen.unmute,
      } as Partial<LocalTrackPublication> as LocalTrackPublication,
    );
    await publisher.startPublishing();
    await publisher.stopPublishing();
    vi.mocked(microphone.resumeUpstream).mockRejectedValueOnce(
      new Error("mic resume failed"),
    );

    await publisher.startPublishing();
    expect(microphone.resumeUpstream).toHaveBeenCalledOnce();
    expect(camera.resumeUpstream).toHaveBeenCalledOnce();
    expect(screen.resumeUpstream).toHaveBeenCalledOnce();
    expect(microphone.isUpstreamPaused).toBe(true);
    expect(camera.isUpstreamPaused).toBe(false);
    expect(screen.isUpstreamPaused).toBe(false);

    await publisher.startPublishing();
    expect(microphone.resumeUpstream).toHaveBeenCalledTimes(2);
    expect(microphone.isUpstreamPaused).toBe(false);
  });

  it("resumes screenshare upstream when publishing starts again", async () => {
    const screenTrack = createMockLocalTrack(Track.Source.ScreenShare);
    trackPublications.push({
      track: screenTrack,
      source: Track.Source.ScreenShare,
      mute: screenTrack.mute,
      unmute: screenTrack.unmute,
    } as Partial<LocalTrackPublication> as LocalTrackPublication);
    await publisher.startPublishing();
    await publisher.stopPublishing();

    await publisher.startPublishing();

    expect(screenTrack.resumeUpstream).toHaveBeenCalledOnce();
    expect(screenTrack.isUpstreamPaused).toBe(false);
  });

  it("keeps camera behavior while also resuming screenshare upstream", async () => {
    const cameraTrack = createMockLocalTrack(Track.Source.Camera);
    const screenTrack = createMockLocalTrack(Track.Source.ScreenShare);
    trackPublications.push(
      {
        track: cameraTrack,
        source: Track.Source.Camera,
        mute: cameraTrack.mute,
        unmute: cameraTrack.unmute,
      } as Partial<LocalTrackPublication> as LocalTrackPublication,
      {
        track: screenTrack,
        source: Track.Source.ScreenShare,
        mute: screenTrack.mute,
        unmute: screenTrack.unmute,
      } as Partial<LocalTrackPublication> as LocalTrackPublication,
    );
    await publisher.startPublishing();
    await publisher.stopPublishing();

    await publisher.startPublishing();

    expect(cameraTrack.resumeUpstream).toHaveBeenCalledOnce();
    expect(screenTrack.resumeUpstream).toHaveBeenCalledOnce();
  });

  it("retries a failed new-track pause when disabled is requested again", async () => {
    await publisher.setPublishingEnabled(false);
    const track = createMockLocalTrack(Track.Source.Microphone);
    vi.mocked(track.pauseUpstream).mockRejectedValueOnce(
      new Error("pause failed"),
    );
    const publication = {
      track,
      source: track.source,
    } as LocalTrackPublication;
    trackPublications.push(publication);
    localParticipant.emit(ParticipantEvent.LocalTrackPublished, publication);
    await flushPromises();
    expect(track.isUpstreamPaused).toBe(false);

    await publisher.setPublishingEnabled(false);
    expect(track.pauseUpstream).toHaveBeenCalledTimes(2);
    expect(track.isUpstreamPaused).toBe(true);
  });

  it("does not resume an upstream paused by another owner", async () => {
    const track = createMockLocalTrack(Track.Source.Camera);
    await track.pauseUpstream();
    trackPublications.push({
      track,
      source: Track.Source.Camera,
      mute: track.mute,
      unmute: track.unmute,
    } as Partial<LocalTrackPublication> as LocalTrackPublication);

    await publisher.startPublishing();

    expect(track.resumeUpstream).not.toHaveBeenCalled();
    expect(track.isUpstreamPaused).toBe(true);
  });

  it("pauses and resumes screen-share audio with publishing", async () => {
    const track = createMockLocalTrack(Track.Source.ScreenShareAudio);
    trackPublications.push({
      track,
      source: Track.Source.ScreenShareAudio,
      mute: track.mute,
      unmute: track.unmute,
    } as Partial<LocalTrackPublication> as LocalTrackPublication);
    localParticipant.emit(ParticipantEvent.LocalTrackPublished, {
      track,
      source: Track.Source.ScreenShareAudio,
    } as LocalTrackPublication);
    await flushPromises();

    await publisher.startPublishing();

    expect(track.pauseUpstream).toHaveBeenCalledOnce();
    expect(track.resumeUpstream).toHaveBeenCalledOnce();
    expect(track.isUpstreamPaused).toBe(false);
  });

  it("does not start a second pause after unpublish while pause is pending", async () => {
    const track = createMockLocalTrack(Track.Source.Camera);
    const publication = {
      track,
      source: track.source,
      mute: track.mute,
      unmute: track.unmute,
    } as Partial<LocalTrackPublication> as LocalTrackPublication;
    trackPublications.push(publication);
    await publisher.startPublishing();

    const pause = Promise.withResolvers<void>();
    vi.mocked(track.pauseUpstream).mockImplementationOnce(async () => {
      await pause.promise;
    });
    const stop = publisher.stopPublishing();
    await flushPromises();
    expect(track.pauseUpstream).toHaveBeenCalledOnce();

    // A second publication notification waits on the first pause operation.
    localParticipant.emit(ParticipantEvent.LocalTrackPublished, publication);
    await flushPromises();
    await localParticipant.unpublishTrack(track);
    pause.resolve();
    await stop;
    await flushPromises();

    expect(track.pauseUpstream).toHaveBeenCalledOnce();
  });

  it("does not start a second pause after destroy while pause is pending", async () => {
    const track = createMockLocalTrack(Track.Source.Camera);
    const publication = {
      track,
      source: track.source,
      mute: track.mute,
      unmute: track.unmute,
    } as Partial<LocalTrackPublication> as LocalTrackPublication;
    trackPublications.push(publication);
    await publisher.startPublishing();

    const pause = Promise.withResolvers<void>();
    vi.mocked(track.pauseUpstream).mockImplementationOnce(async () => {
      await pause.promise;
    });
    const stop = publisher.stopPublishing();
    await flushPromises();
    expect(track.pauseUpstream).toHaveBeenCalledOnce();

    // A second publication notification waits on the first pause operation.
    localParticipant.emit(ParticipantEvent.LocalTrackPublished, publication);
    await flushPromises();
    const destroy = publisher.destroy();
    pause.resolve();
    await Promise.all([stop, destroy]);
    await flushPromises();

    expect(track.pauseUpstream).toHaveBeenCalledOnce();
  });

  it("resumes after reconnect races an asynchronous pause", async () => {
    const track = createMockLocalTrack(Track.Source.Camera);
    trackPublications.push({
      track,
      source: Track.Source.Camera,
      mute: track.mute,
      unmute: track.unmute,
    } as Partial<LocalTrackPublication> as LocalTrackPublication);

    await publisher.startPublishing();

    const pause = Promise.withResolvers<void>();
    vi.mocked(track.pauseUpstream).mockImplementationOnce(async () => {
      // @ts-expect-error - for that test we want to set isUpstreamPaused directly
      track.isUpstreamPaused = true;
      await pause.promise;
    });
    const stop = publisher.stopPublishing();
    await flushPromises();
    expect(track.pauseUpstream).toHaveBeenCalledOnce();

    const start = publisher.startPublishing();
    pause.resolve();
    await Promise.all([stop, start]);

    expect(track.resumeUpstream).toHaveBeenCalledOnce();
    expect(track.isUpstreamPaused).toBe(false);
  });

  it("does not start a resume after destroy", async () => {
    const track = createMockLocalTrack(Track.Source.Camera);
    trackPublications.push({
      track,
      source: Track.Source.Camera,
      mute: track.mute,
      unmute: track.unmute,
    } as Partial<LocalTrackPublication> as LocalTrackPublication);
    await publisher.startPublishing();
    await publisher.stopPublishing();

    const resume = Promise.withResolvers<void>();
    vi.mocked(track.resumeUpstream).mockImplementationOnce(async () => {
      // @ts-expect-error - for that test we want to set isUpstreamPaused directly
      track.isUpstreamPaused = false;
      await resume.promise;
    });
    vi.spyOn(localParticipant, "unpublishTrack").mockResolvedValue(
      {} as LocalTrackPublication,
    );
    const start = publisher.startPublishing();
    await flushPromises();
    expect(track.resumeUpstream).toHaveBeenCalledOnce();

    const resumeCallsAtDestroy = vi.mocked(track.resumeUpstream).mock.calls
      .length;
    const pauseCallsAtDestroy = vi.mocked(track.pauseUpstream).mock.calls
      .length;
    const destroy = publisher.destroy();
    resume.resolve();
    await Promise.all([start, destroy]);

    expect(track.resumeUpstream).toHaveBeenCalledTimes(resumeCallsAtDestroy);
    // An in-flight LiveKit resume cannot be cancelled. Destroy must not issue a
    // compensating pause after the operation settles; stopTracks is its explicit
    // cleanup path.
    expect(track.pauseUpstream).toHaveBeenCalledTimes(pauseCallsAtDestroy);
  });

  it("pauses again when disconnect races an asynchronous resume", async () => {
    const track = createMockLocalTrack(Track.Source.Camera);
    trackPublications.push({
      track,
      source: Track.Source.Camera,
      mute: track.mute,
      unmute: track.unmute,
    } as Partial<LocalTrackPublication> as LocalTrackPublication);

    await publisher.startPublishing();
    await publisher.stopPublishing();

    const resume = Promise.withResolvers<void>();
    vi.mocked(track.resumeUpstream).mockImplementationOnce(async () => {
      // @ts-expect-error - for that test we want to set isUpstreamPaused directly
      track.isUpstreamPaused = false;
      await resume.promise;
    });
    const start = publisher.startPublishing();
    await flushPromises();
    expect(track.resumeUpstream).toHaveBeenCalledOnce();

    const stop = publisher.stopPublishing();
    resume.resolve();
    await Promise.all([start, stop]);

    expect(track.pauseUpstream).toHaveBeenCalledTimes(2);
    expect(track.isUpstreamPaused).toBe(true);
  });

  describe("Mute states", () => {
    let publisher: Publisher;
    beforeEach(() => {
      publisher = new Publisher(
        connection,
        mockMediaDevices({}),
        muteStates,
        constant({ supported: false, processor: undefined }),
        logger,
        false,
      );
    });
    afterEach(async () => {
      await publisher.destroy();
    });

    test.each([
      { mutes: { audioEnabled: true, videoEnabled: false } },
      { mutes: { audioEnabled: true, videoEnabled: false } },
    ])("only create the tracks that are unmuted $mutes", async ({ mutes }) => {
      audioEnabled$.next(mutes.audioEnabled);
      videoEnabled$.next(mutes.videoEnabled);

      vi.mocked(connection.livekitRoom.localParticipant).createTracks = vi
        .fn()
        .mockResolvedValue([]);

      await publisher.createAndSetupTracks();

      expect(
        connection.livekitRoom.localParticipant.createTracks,
      ).toHaveBeenCalledOnce();

      expect(
        connection.livekitRoom.localParticipant.createTracks,
      ).toHaveBeenCalledWith({
        audio: mutes.audioEnabled ? true : undefined,
        video: mutes.videoEnabled ? true : undefined,
      });
    });
  });

  it("does mute unmute audio", async () => {});
});

describe("Bug fix", () => {
  it("wrongly publish tracks while muted", async () => {
    const publisher = new Publisher(
      connection,
      mockMediaDevices({}),
      muteStates,
      constant({ supported: false, processor: undefined }),
      logger,
      false,
    );
    audioEnabled$.next(true);

    const resolvers = Promise.withResolvers<void>();
    createTrackLock = resolvers.promise;

    const createTracks = publisher.createAndSetupTracks();
    void publisher.startPublishing();
    void createTracks.then(() => {
      void publisher.startPublishing();
    });
    audioEnabled$.next(false);
    resolvers.resolve(undefined);
    await createTracks;

    await flushPromises();

    const track = localParticipant.getTrackPublication(
      Track.Source.Microphone,
    )?.track;
    expect(track).toBeDefined();

    try {
      expect(localParticipant.publishTrack).not.toHaveBeenCalled();
    } catch {
      expect(track!.mute).toHaveBeenCalled();
      expect(track!.isMuted).toBe(true);
    }
    await publisher.destroy();
  });
});
