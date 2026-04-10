/*
Copyright 2023, 2024 New Vector Ltd.
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  BehaviorSubject,
  combineLatest,
  filter,
  map,
  type Observable,
  of,
  Subject,
  switchMap,
} from "rxjs";
import {
  type TrackReferenceOrPlaceholder,
  observeParticipantEvents,
  observeParticipantMedia,
} from "@livekit/components-core";
import { ParticipantEvent, Track } from "livekit-client";

import { type ReactionOption } from "../../reactions";
import { type Behavior } from "../Behavior";
import { observeTrackReference$ } from "../observeTrackReference";
import { type LocalUserMediaViewModel } from "./LocalUserMediaViewModel";
import {
  createMemberMedia,
  type MemberMediaInputs,
  type BaseMemberMediaViewModel,
} from "./MemberMediaViewModel";
import { type RemoteUserMediaViewModel } from "./RemoteUserMediaViewModel";
import { type ObservableScope } from "../ObservableScope";
import { showConnectionStats } from "../../settings/settings";
import { observeRtpStreamStats$ } from "./observeRtpStreamStats";
import { videoFit$, videoSizeFromParticipant$ } from "../../utils/videoFit.ts";

/**
 * A participant's user media (i.e. their microphone and camera feed).
 */
export type UserMediaViewModel =
  | LocalUserMediaViewModel
  | RemoteUserMediaViewModel;

export type DisplaySource = "camera" | "screen";

export interface BaseUserMediaViewModel extends BaseMemberMediaViewModel {
  type: "user";
  speaking$: Behavior<boolean>;
  audioEnabled$: Behavior<boolean>;
  videoEnabled$: Behavior<boolean>;
  screenVideo$: Behavior<TrackReferenceOrPlaceholder | undefined>;
  hasScreenShare$: Behavior<boolean>;
  displaySource$: Behavior<DisplaySource>;
  activeVideo$: Behavior<TrackReferenceOrPlaceholder | undefined>;
  activeVideoEnabled$: Behavior<boolean>;
  videoFit$: Behavior<"cover" | "contain">;
  toggleCropVideo: () => void;
  toggleDisplaySource: () => void;
  /**
   * The expected identity of the LiveKit participant. Exposed for debugging.
   */
  rtcBackendIdentity: string;
  handRaised$: Behavior<Date | null>;
  reaction$: Behavior<ReactionOption | null>;
  audioStreamStats$: Observable<
    RTCInboundRtpStreamStats | RTCOutboundRtpStreamStats | undefined
  >;
  videoStreamStats$: Observable<
    RTCInboundRtpStreamStats | RTCOutboundRtpStreamStats | undefined
  >;
  /**
   * Set the target dimensions of the HTML element (final dimension after anim).
   * This can be used to determine the best video fit (fit to frame / keep ratio).
   * @param targetWidth - The target width of the HTML element displaying the video.
   * @param targetHeight - The target height of the HTML element displaying the video.
   */
  setTargetDimensions: (targetWidth: number, targetHeight: number) => void;
}

export interface BaseUserMediaInputs extends Omit<
  MemberMediaInputs,
  "audioSource" | "videoSource"
> {
  rtcBackendIdentity: string;
  handRaised$: Behavior<Date | null>;
  reaction$: Behavior<ReactionOption | null>;
  statsType: "inbound-rtp" | "outbound-rtp";
}

export function createBaseUserMedia(
  scope: ObservableScope,
  {
    rtcBackendIdentity,
    handRaised$,
    reaction$,
    statsType,
    ...inputs
  }: BaseUserMediaInputs,
): BaseUserMediaViewModel {
  const { participant$ } = inputs;
  const media$ = scope.behavior(
    participant$.pipe(
      switchMap((p) => (p && observeParticipantMedia(p)) ?? of(undefined)),
    ),
  );
  const toggleCropVideo$ = new Subject<void>();
  const displaySource$ = new BehaviorSubject<DisplaySource>("camera");
  const memberMedia = createMemberMedia(scope, {
    ...inputs,
    audioSource: Track.Source.Microphone,
    videoSource: Track.Source.Camera,
  });
  const screenVideo$ = scope.behavior(
    participant$.pipe(
      switchMap((p) =>
        p ? observeTrackReference$(p, Track.Source.ScreenShare) : of(undefined),
      ),
    ),
  );
  const hasScreenShare$ = scope.behavior(
    screenVideo$.pipe(map((track) => track?.publication !== undefined)),
  );
  const screenVideoEnabled$ = scope.behavior(
    screenVideo$.pipe(map((track) => track?.publication?.isMuted === false)),
  );
  const videoEnabled$ = scope.behavior(
    media$.pipe(map((m) => m?.cameraTrack?.isMuted === false)),
  );
  const activeVideo$ = scope.behavior(
    combineLatest([displaySource$, memberMedia.video$, screenVideo$]).pipe(
      map(([source, camera, screen]) =>
        source === "screen" && screen?.publication ? screen : camera,
      ),
    ),
  );
  const activeVideoEnabled$ = scope.behavior(
    combineLatest([displaySource$, videoEnabled$, screenVideoEnabled$]).pipe(
      map(([source, cameraEnabled, screenEnabled]) =>
        source === "screen" ? screenEnabled : cameraEnabled,
      ),
    ),
  );

  combineLatest([hasScreenShare$, displaySource$])
    .pipe(
      filter(([hasScreenShare, displaySource]) => !hasScreenShare && displaySource === "screen"),
      scope.bind(),
    )
    .subscribe(() => {
      displaySource$.next("camera");
    });

  // The target size of the video element, used to determine the best video fit.
  // The target size is the final size of the HTML element after any animations have completed.
  const targetSize$ = new BehaviorSubject<
    { width: number; height: number } | undefined
  >(undefined);

  return {
    ...memberMedia,
    type: "user",
    speaking$: scope.behavior(
      participant$.pipe(
        switchMap((p) =>
          p
            ? observeParticipantEvents(
                p,
                ParticipantEvent.IsSpeakingChanged,
              ).pipe(map((p) => p.isSpeaking))
            : of(false),
        ),
      ),
    ),
    audioEnabled$: scope.behavior(
      media$.pipe(map((m) => m?.microphoneTrack?.isMuted === false)),
    ),
    videoEnabled$,
    screenVideo$,
    hasScreenShare$,
    displaySource$: scope.behavior(displaySource$),
    activeVideo$,
    activeVideoEnabled$,
    videoFit$: videoFit$(
      scope,
      videoSizeFromParticipant$(participant$),
      targetSize$,
    ),
    toggleCropVideo: () => toggleCropVideo$.next(),
    toggleDisplaySource: (): void => {
      const current = displaySource$.value;
      const next = current === "camera" ? "screen" : "camera";
      if (next === "camera" || hasScreenShare$.value) {
        displaySource$.next(next);
      }
    },
    rtcBackendIdentity,
    handRaised$,
    reaction$,
    audioStreamStats$: combineLatest([
      participant$,
      showConnectionStats.value$,
    ]).pipe(
      switchMap(([p, showConnectionStats]) => {
        //
        if (!p || !showConnectionStats) return of(undefined);
        return observeRtpStreamStats$(p, Track.Source.Microphone, statsType);
      }),
    ),
    videoStreamStats$: combineLatest([
      participant$,
      showConnectionStats.value$,
    ]).pipe(
      switchMap(([p, showConnectionStats]) => {
        if (!p || !showConnectionStats) return of(undefined);
        return observeRtpStreamStats$(p, Track.Source.Camera, statsType);
      }),
    ),
    setTargetDimensions: (targetWidth: number, targetHeight: number): void => {
      targetSize$.next({ width: targetWidth, height: targetHeight });
    },
  };
}
