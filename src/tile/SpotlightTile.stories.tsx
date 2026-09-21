/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type Meta, type StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { BehaviorSubject } from "rxjs";

import { SpotlightTile } from "./SpotlightTile";
import { SpotlightTileViewModel } from "../state/TileViewModel";
import { type Behavior } from "../state/Behavior";
import { type MediaViewModel } from "../state/media/MediaViewModel";
import { type RemoteUserMediaViewModel } from "../state/media/RemoteUserMediaViewModel";
import { type RemoteScreenShareViewModel } from "../state/media/RemoteScreenShareViewModel";

function behavior<T>(value: T): Behavior<T> {
  return new BehaviorSubject(value);
}

function remoteCamera(id: string): RemoteUserMediaViewModel {
  return {
    id,
    userId: "@alice:example.org",
    type: "user",
    local: false,
    displayName$: behavior("Alice"),
    mxcAvatarUrl$: behavior(undefined),
    video$: behavior(undefined),
    focusUrl$: behavior(undefined),
    unencryptedWarning$: behavior(false),
    encryptionStatus$: behavior(1),
    waitingForMedia$: behavior(false),
    videoEnabled$: behavior(true),
    speaking$: behavior(false),
    audioEnabled$: behavior(false),
    videoOrientation$: behavior("landscape"),
    rtcBackendIdentity: "@alice:example.org:AAAA",
    handRaised$: behavior(null),
    reaction$: behavior(null),
    audioStreamStats$: behavior(undefined),
    videoStreamStats$: behavior(undefined),
    toggleCropVideo: () => {},
    setVideoAspectRatio: () => {},
  } as unknown as RemoteUserMediaViewModel;
}

function remoteScreenShare(id: string): RemoteScreenShareViewModel {
  return {
    id,
    userId: "@alice:example.org",
    type: "screen share",
    local: false,
    displayName$: behavior("Alice"),
    mxcAvatarUrl$: behavior(undefined),
    video$: behavior(undefined),
    focusUrl$: behavior(undefined),
    unencryptedWarning$: behavior(false),
    encryptionStatus$: behavior(1),
    videoEnabled$: behavior(true),
    audioEnabled$: behavior(false),
    playbackMuted$: behavior(false),
    playbackVolume$: behavior(1),
    togglePlaybackMuted: () => {},
    adjustPlaybackVolume: () => {},
    commitPlaybackVolume: () => {},
  } as RemoteScreenShareViewModel;
}

const camera = remoteCamera("@alice:example.org:AAAA:0");
const screenShare = remoteScreenShare(`${camera.id}:screen-share`);
const media: MediaViewModel[] = [screenShare, camera];

const meta: Meta<typeof SpotlightTile> = {
  component: SpotlightTile,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof meta>;

// Presentation coverage: CallViewModel candidate construction is covered by the
// VM tests and the widget screen-share e2e spec.
export const CameraAndScreenShare: Story = {
  args: {
    vm: new SpotlightTileViewModel(
      new BehaviorSubject(media),
      behavior(false),
      behavior("solid"),
    ),
    expanded: false,
    onToggleExpanded: null,
    targetWidth: 640,
    targetHeight: 360,
    showIndicators: true,
    showNameTags: true,
    showRingingStatus: true,
    focusable: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const cameraItem = canvasElement.querySelector(`[data-id="${camera.id}"]`);
    await expect(cameraItem).toHaveAttribute("aria-hidden", "true");

    await userEvent.click(canvas.getByRole("button", { name: "Next" }));
    await expect(cameraItem).not.toHaveAttribute("aria-hidden", "true");
  },
};
