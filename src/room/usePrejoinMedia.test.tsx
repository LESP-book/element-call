/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { act, render } from "@testing-library/react";
import { type JSX } from "react";
import { BehaviorSubject, NEVER } from "rxjs";
import { beforeEach, expect, test, vi } from "vitest";

import { MediaDevicesContext } from "../MediaDevicesContext";
import { type MuteStates } from "../state/MuteStates";
import { constant } from "../state/Behavior";
import { mockMediaDevices } from "../utils/test";
import { usePrejoinMedia } from "./usePrejoinMedia";

const previewTracks = vi.hoisted(() => ({
  value: undefined as unknown[] | undefined,
  options: [] as Array<{ audio: unknown; video: unknown }>,
  onError: undefined as ((error: Error) => void) | undefined,
}));

vi.mock("@livekit/components-react", () => ({
  usePreviewTracks: (
    options: unknown,
    onError?: (error: Error) => void,
  ): unknown[] | undefined => {
    previewTracks.options.push(options as { audio: unknown; video: unknown });
    previewTracks.onError = onError;
    return previewTracks.value;
  },
}));

vi.mock("../livekit/TrackProcessorContext", () => ({
  useTrackProcessor: () => ({
    supported: false,
    processor: undefined,
  }),
  useTrackProcessorSync: (): void => {},
}));

const mediaCombinations = [
  { name: "audio and video muted", audio: false, video: false },
  { name: "video only", audio: false, video: true },
  { name: "audio only", audio: true, video: false },
  { name: "audio and video enabled", audio: true, video: true },
] as const;

test.each(mediaCombinations)(
  "uses each initial media toggle for a direct join ($name)",
  ({ audio, video }) => {
    previewTracks.value = undefined;
    const rendered = renderPrejoinMedia(audio, video, true);
    const options = latestPreviewOptions();

    expect(options.audio).toEqual(audio ? { deviceId: "microphone" } : false);
    expect(options.video).toEqual(
      video ? { deviceId: "camera", processor: undefined } : false,
    );
    expect(rendered.getByTestId("ready")).toHaveTextContent(
      audio || video ? "pending" : "ready",
    );

    rendered.updateTracks([]);
    expect(rendered.getByTestId("ready")).toHaveTextContent("ready");
  },
);

test.each(mediaCombinations.filter(({ audio, video }) => audio || video))(
  "mutes both direct-join toggles after permission rejection ($name)",
  ({ audio, video }) => {
    previewTracks.value = undefined;
    const rendered = renderPrejoinMedia(audio, video, true);
    expect(rendered.getByTestId("ready")).toHaveTextContent("pending");

    act(() => {
      previewTracks.onError?.(new Error("Permission denied"));
    });

    expect(rendered.audioSetEnabled).toHaveBeenCalledWith(false);
    expect(rendered.videoSetEnabled).toHaveBeenCalledWith(false);
    expect(rendered.getByTestId("ready")).toHaveTextContent("ready");
  },
);

test("keeps lobby preauthorization for a fully muted call", () => {
  previewTracks.value = undefined;
  const rendered = renderPrejoinMedia(false, false, false);

  expect(latestPreviewOptions()).toEqual({ audio: {}, video: false });
  expect(rendered.getByTestId("ready")).toHaveTextContent("pending");

  act(() => {
    previewTracks.onError?.(new Error("Permission denied"));
  });

  expect(rendered.getByTestId("ready")).toHaveTextContent("ready");
});

test("does not throw when a pending permission callback arrives after unmount", () => {
  previewTracks.value = undefined;
  const rendered = renderPrejoinMedia(true, true, true);

  rendered.unmount();
  expect(() => {
    act(() => {
      previewTracks.onError?.(new Error("Permission denied"));
    });
  }).not.toThrow();
});

beforeEach(() => {
  previewTracks.value = undefined;
  previewTracks.options = [];
  previewTracks.onError = undefined;
});

function renderPrejoinMedia(
  audioEnabled: boolean,
  videoEnabled: boolean,
  onlyWhenEnabled: boolean,
) {
  const { muteStates, audioSetEnabled, videoSetEnabled } = createMuteStates(
    audioEnabled,
    videoEnabled,
  );
  const mediaDevices = mockMediaDevices({
    audioInput: {
      available$: constant(
        new Map([
          ["microphone", { type: "name" as const, name: "Microphone" }],
        ]),
      ),
      selected$: constant({
        id: "microphone",
        hardwareDeviceChange$: NEVER,
      }),
      select: vi.fn(),
    },
    videoInput: {
      available$: constant(
        new Map([["camera", { type: "name" as const, name: "Camera" }]]),
      ),
      selected$: constant({ id: "camera" }),
      select: vi.fn(),
    },
  });
  const view = (): JSX.Element => (
    <MediaDevicesContext value={mediaDevices}>
      <PrejoinMediaHarness
        muteStates={muteStates}
        onlyWhenEnabled={onlyWhenEnabled}
      />
    </MediaDevicesContext>
  );
  const rendered = render(view());

  return {
    ...rendered,
    audioSetEnabled,
    videoSetEnabled,
    updateTracks(value: unknown[] | undefined): void {
      previewTracks.value = value;
      rendered.rerender(view());
    },
  };
}

function latestPreviewOptions(): { audio: unknown; video: unknown } {
  const options = previewTracks.options.at(-1);
  if (options === undefined)
    throw new Error("Preview options were not captured");
  return options;
}

function createMuteStates(
  audioEnabled: boolean,
  videoEnabled: boolean,
): {
  muteStates: MuteStates;
  audioSetEnabled: ReturnType<typeof vi.fn>;
  videoSetEnabled: ReturnType<typeof vi.fn>;
} {
  const audioEnabled$ = new BehaviorSubject(audioEnabled);
  const videoEnabled$ = new BehaviorSubject(videoEnabled);
  const audioSetEnabled = vi.fn((enabled: boolean) =>
    audioEnabled$.next(enabled),
  );
  const videoSetEnabled = vi.fn((enabled: boolean) =>
    videoEnabled$.next(enabled),
  );

  return {
    muteStates: {
      audio: {
        enabled$: audioEnabled$,
        setEnabled$: constant(audioSetEnabled),
      },
      video: {
        enabled$: videoEnabled$,
        setEnabled$: constant(videoSetEnabled),
      },
    } as unknown as MuteStates,
    audioSetEnabled,
    videoSetEnabled,
  };
}

function PrejoinMediaHarness({
  muteStates,
  onlyWhenEnabled,
}: {
  muteStates: MuteStates;
  onlyWhenEnabled: boolean;
}): JSX.Element {
  const { ready } = usePrejoinMedia(muteStates, onlyWhenEnabled);
  return <output data-testid="ready">{ready ? "ready" : "pending"}</output>;
}
