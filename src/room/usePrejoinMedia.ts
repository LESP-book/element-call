/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePreviewTracks } from "@livekit/components-react";
import {
  type CreateLocalTracksOptions,
  type LocalAudioTrack,
  type LocalVideoTrack,
  Track,
} from "livekit-client";
import { logger } from "matrix-js-sdk/lib/logger";
import { useObservableEagerState } from "observable-hooks";

import { useMediaDevices } from "../MediaDevicesContext";
import { type MuteStates } from "../state/MuteStates";
import { useInitial } from "../useInitial";
import {
  useTrackProcessor,
  useTrackProcessorSync,
} from "../livekit/TrackProcessorContext";
import { getValue } from "../utils/observable";
import { useBehavior } from "../useBehavior";

interface PrejoinMedia {
  tracks: Array<LocalAudioTrack | LocalVideoTrack> | undefined;
  ready: boolean;
}

/**
 * Opens preview tracks before joining so browser media permission is settled
 * before LiveKit starts connecting.
 *
 * @param onlyWhenEnabled Skip opening devices when both media kinds are muted.
 *   The lobby always prepares permissions, while direct joins must preserve the
 *   existing privacy behavior for muted calls.
 */
export function usePrejoinMedia(
  muteStates: MuteStates,
  onlyWhenEnabled = false,
): PrejoinMedia {
  const audioEnabled = useBehavior(muteStates.audio.enabled$);
  const videoEnabled = useBehavior(muteStates.video.enabled$);
  const shouldPrepare = !onlyWhenEnabled || audioEnabled || videoEnabled;
  const devices = useMediaDevices();
  const videoInputId = useObservableEagerState(
    devices.videoInput.selected$,
  )?.id;

  const initialAudioOptions = useInitial(
    () =>
      audioEnabled && {
        deviceId: getValue(devices.audioInput.selected$)?.id,
      },
  );
  const { processor } = useTrackProcessor();
  const initialProcessor = useInitial(() => processor);
  const localTrackOptions = useMemo<CreateLocalTracksOptions>(
    () => ({
      // Audio is opened with video so the browser shows one permission prompt.
      // Clone the options because LiveKit mutates the object it receives.
      audio: shouldPrepare && Object.assign({}, initialAudioOptions),
      video: shouldPrepare &&
        videoEnabled && {
          deviceId: videoInputId,
          processor: initialProcessor,
        },
    }),
    [
      initialAudioOptions,
      initialProcessor,
      shouldPrepare,
      videoEnabled,
      videoInputId,
    ],
  );
  const [preparationFailed, setPreparationFailed] = useState(false);
  const onError = useCallback(
    (error: Error) => {
      logger.error("Error while creating preview Tracks:", error);
      setPreparationFailed(true);
      muteStates.audio.setEnabled$.value?.(false);
      muteStates.video.setEnabled$.value?.(false);
    },
    [muteStates],
  );
  const tracks = usePreviewTracks(localTrackOptions, onError);
  const videoTrack = useMemo(
    () =>
      (tracks?.find((track) => track.kind === Track.Kind.Video) ??
        null) as LocalVideoTrack | null,
    [tracks],
  );

  useEffect(() => {
    if (videoTrack && videoInputId === undefined) {
      devices.requestDeviceNames();
    }
  }, [devices, videoInputId, videoTrack]);

  useTrackProcessorSync(videoTrack);

  return {
    tracks,
    // A direct join waits until a failed permission request has propagated the
    // muted state. Otherwise ActiveCall could immediately request media again.
    ready:
      !shouldPrepare ||
      tracks !== undefined ||
      (!onlyWhenEnabled && preparationFailed),
  };
}
