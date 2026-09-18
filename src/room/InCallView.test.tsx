/*
Copyright 2025 New Vector Ltd.
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  beforeEach,
  describe,
  expect,
  it,
  type MockedFunction,
  vi,
} from "vitest";
import {
  act,
  fireEvent,
  render,
  type RenderResult,
} from "@testing-library/react";
import { type LocalParticipant } from "livekit-client";
import { BehaviorSubject, of } from "rxjs";
import { BrowserRouter } from "react-router-dom";
import { TooltipProvider } from "@vector-im/compound-web";
import { RoomContext, useLocalParticipant } from "@livekit/components-react";
import userEvent from "@testing-library/user-event";

import { ActiveCall, InCallView } from "./InCallView";
import {
  mockLivekitRoom,
  mockLocalParticipant,
  mockMediaDevices,
  mockMuteStates,
  mockRemoteParticipant,
  mockRtcMembership,
  type MockRTCSession,
} from "../utils/test";
import { E2eeType } from "../e2ee/e2eeType";
import {
  getBasicCallViewModelEnvironment,
  getBasicRTCSession,
} from "../utils/test-viewmodel";
import {
  type CallViewModel,
  type CallViewModelOptions,
} from "../state/CallViewModel/CallViewModel";
import { alice, local } from "../utils/test-fixtures";
import { ReactionsSenderProvider } from "../reactions/useReactionsSender";
import { useRoomEncryptionSystem } from "../e2ee/sharedKeyManagement";
import { LivekitRoomAudioRenderer } from "../livekit/MatrixAudioRenderer";
import { MediaDevicesContext } from "../MediaDevicesContext";
import { type MediaDevices as ECMediaDevices } from "../state/MediaDevices";
import { AppBar } from "../AppBar";
import { type MatrixInfo } from "./VideoPreview";
import { ProcessorProvider } from "../livekit/TrackProcessorContext";
import { initializeWidget } from "../widget";
import { RootElementProvider } from "../RootElementContext";

initializeWidget();
vi.hoisted(
  () =>
    // Use globalThis rather than global because vite-plugin-node-polyfills seems
    // to rewrite global into an import which then interferes with vitest's hoisting
    // which runs before imports.
    (globalThis.ImageData = class MockImageData {
      public data: number[] = [];
    } as unknown as typeof ImageData),
);

vi.mock("../soundUtils");
vi.mock("../useAudioContext");
vi.mock("../tile/GridTile");
vi.mock("../tile/SpotlightTile");
vi.mock("@livekit/components-react");
vi.mock("livekit-client/e2ee-worker?worker");
vi.mock("../e2ee/sharedKeyManagement");
vi.mock("../livekit/MatrixAudioRenderer");
vi.mock("react-use-measure", () => ({
  default: (): [() => void, object] => [(): void => {}, {}],
}));

const localRtcMember = mockRtcMembership("@carol:example.org", "CCCC");
const localParticipant = mockLocalParticipant({
  identity: "@local:example.org:AAAAAA",
});
const remoteParticipant = mockRemoteParticipant({
  identity: "@alice:example.org:AAAAAA",
});

const matrixInfo = {
  userId: "",
  displayName: "",
  avatarUrl: "",
  roomId: "",
  roomName: "",
  roomAlias: null,
  roomAvatar: null,
  e2eeSystem: { kind: E2eeType.NONE },
} satisfies MatrixInfo;

let useRoomEncryptionSystemMock: MockedFunction<typeof useRoomEncryptionSystem>;

function pointerEvent(
  type: string,
  pointerType: "mouse" | "touch",
  relatedTarget?: EventTarget,
): Event {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  if (relatedTarget !== undefined) {
    Object.defineProperty(event, "relatedTarget", { value: relatedTarget });
  }
  return event;
}

beforeEach(() => {
  vi.clearAllMocks();

  // MatrixAudioRenderer is tested separately.
  (
    LivekitRoomAudioRenderer as MockedFunction<typeof LivekitRoomAudioRenderer>
  ).mockImplementation((_props) => {
    return <div>mocked: MatrixAudioRenderer</div>;
  });
  (
    useLocalParticipant as MockedFunction<typeof useLocalParticipant>
  ).mockImplementation(
    () =>
      ({
        isScreenShareEnabled: false,
        localParticipant: localRtcMember as unknown as LocalParticipant,
      }) as unknown as ReturnType<typeof useLocalParticipant>,
  );
  useRoomEncryptionSystemMock =
    useRoomEncryptionSystem as typeof useRoomEncryptionSystemMock;
  useRoomEncryptionSystemMock.mockReturnValue({ kind: E2eeType.NONE });
});
interface CreateInCallViewArgs {
  mediaDevices?: ECMediaDevices;
  callViewModelOptions?: Partial<CallViewModelOptions>;
  /** If true, wraps the rendered tree in an AppBar provider */
  withAppBar?: boolean;
}
function createInCallView(args: CreateInCallViewArgs = {}): RenderResult & {
  rtcSession: MockRTCSession;
  vm: CallViewModel;
} {
  const mediaDevices = args.mediaDevices ?? mockMediaDevices({});
  const muteState = mockMuteStates();
  const livekitRoom = mockLivekitRoom(
    {
      localParticipant,
    },
    {
      remoteParticipants$: of([remoteParticipant]),
    },
  );
  const { vm, footerVm, developerSettingsVm, rtcSession } =
    getBasicCallViewModelEnvironment(
      [local, alice],
      undefined,
      mediaDevices,
      args.callViewModelOptions,
    );

  rtcSession.joined = true;
  const room = rtcSession.room;
  const client = room.client;

  const inCallView = (
    <InCallView
      client={client}
      rtcSession={rtcSession.asMockedSession()}
      muteStates={muteState}
      vm={vm}
      footerVm={footerVm}
      developerSettingsVm={developerSettingsVm}
      matrixInfo={matrixInfo}
      matrixRoom={room}
      onShareClick={null}
    />
  );

  const content = args.withAppBar ? <AppBar>{inCallView}</AppBar> : inCallView;

  const renderResult = render(
    <BrowserRouter>
      <MediaDevicesContext value={mediaDevices}>
        <ReactionsSenderProvider
          vm={vm}
          rtcSession={rtcSession.asMockedSession()}
        >
          <TooltipProvider>
            <RoomContext value={livekitRoom}>{content}</RoomContext>
          </TooltipProvider>
        </ReactionsSenderProvider>
      </MediaDevicesContext>
    </BrowserRouter>,
  );
  return {
    ...renderResult,
    rtcSession,
    vm,
  };
}

describe("InCallView", () => {
  describe("rendering", () => {
    it("renders", () => {
      const { container } = createInCallView();
      expect(container).toMatchSnapshot();
    });
  });

  describe("audioOutputSwitcher", () => {
    it("is visible and can be clicked", async () => {
      const user = userEvent.setup();
      const switchFn = vi.fn();
      // Create mediaDevices with a speaker and an earpiece available,
      // with the speaker currently selected.
      // This is needed so that the audio switcher button is visible
      const available$ = new BehaviorSubject(
        new Map<string, { type: "speaker" } | { type: "earpiece" }>([
          ["speaker-id", { type: "speaker" }],
          ["earpiece-id", { type: "earpiece" }],
        ]),
      );
      const selected$ = new BehaviorSubject({
        id: "speaker-id",
        virtualEarpiece: false,
      });

      const mediaDevices = mockMediaDevices({
        audioOutput: {
          available$,
          selected$,
          select: switchFn,
        },
      });

      const { getByRole } = createInCallView({ mediaDevices });
      // The button should be visible. When current output is "speaker",
      const audioOutputBtn = getByRole("button", { name: "Loudspeaker" });
      expect(audioOutputBtn).toBeVisible();

      await user.click(audioOutputBtn);

      // Clicking the button should call select -> switchFn with the earpiece device id
      expect(switchFn).toHaveBeenCalledWith("earpiece-id");
    });
  });

  describe("touch interactions", () => {
    it("does not treat toolbar pointerup as a background tap", () => {
      const { vm, getByTestId } = createInCallView();
      const tapScreen = vi.spyOn(vm, "tapScreen");
      const toolbar = getByTestId("footer-container").firstElementChild;

      expect(toolbar).not.toBeNull();
      fireEvent(toolbar!, pointerEvent("pointerup", "touch"));

      expect(tapScreen).not.toHaveBeenCalled();
    });

    it("treats a touch on the call view background as a screen tap", () => {
      const { vm, container } = createInCallView();
      const tapScreen = vi.spyOn(vm, "tapScreen");
      const inRoom = container.firstElementChild;

      expect(inRoom).not.toBeNull();
      fireEvent(inRoom!, pointerEvent("pointerup", "touch"));

      expect(tapScreen).toHaveBeenCalledOnce();
    });

    it("does not unhover the screen for touch pointerleave", () => {
      const { vm, container } = createInCallView();
      const unhoverScreen = vi.spyOn(vm, "unhoverScreen");
      const inRoom = container.firstElementChild;

      expect(inRoom).not.toBeNull();
      fireEvent(
        inRoom!,
        pointerEvent("pointerout", "touch", document.createElement("div")),
      );

      expect(unhoverScreen).not.toHaveBeenCalled();
    });

    it("unhovers the screen for mouse pointerleave", () => {
      const { vm, container } = createInCallView();
      const unhoverScreen = vi.spyOn(vm, "unhoverScreen");
      const inRoom = container.firstElementChild;

      expect(inRoom).not.toBeNull();
      fireEvent(
        inRoom!,
        pointerEvent("pointerout", "mouse", document.createElement("div")),
      );

      expect(unhoverScreen).toHaveBeenCalledOnce();
    });
  });
});

describe("ActiveCall", () => {
  it("creates the view models and renders the end-call menu", async () => {
    const user = userEvent.setup();
    const mediaDevices = mockMediaDevices({});
    const { rtcSession, matrixRoom } = getBasicRTCSession([local, alice]);
    const { findByRole } = render(
      <BrowserRouter>
        <MediaDevicesContext value={mediaDevices}>
          <ProcessorProvider>
            <TooltipProvider>
              <RoomContext value={mockLivekitRoom({ localParticipant })}>
                <ActiveCall
                  client={matrixRoom.client}
                  rtcSession={rtcSession.asMockedSession()}
                  matrixRoom={matrixRoom}
                  muteStates={mockMuteStates()}
                  matrixInfo={matrixInfo}
                  onShareClick={null}
                  e2eeSystem={{ kind: E2eeType.NONE }}
                  onLeft={(): void => {}}
                />
              </RoomContext>
            </TooltipProvider>
          </ProcessorProvider>
        </MediaDevicesContext>
      </BrowserRouter>,
    );

    const endCallButton = await findByRole("button", { name: "End call" });
    expect(endCallButton).toBeVisible();
    await user.click(endCallButton);
    expect(
      await findByRole("menuitem", { name: "End for everyone" }),
    ).toBeVisible();
  });

  it("lays the call out for the size of its root element", async () => {
    // jsdom has no layout and no ResizeObserver: the root reports whatever
    // size we say, and the observer notifies whenever we tell it to
    let size = { width: 1000, height: 800 };
    const root = document.createElement("div");
    Object.defineProperty(root, "clientWidth", { get: () => size.width });
    Object.defineProperty(root, "clientHeight", { get: () => size.height });
    document.body.appendChild(root);

    const observers: (() => void)[] = [];
    const originalResizeObserver = window.ResizeObserver;
    window.ResizeObserver = class {
      public constructor(private readonly callback: ResizeObserverCallback) {}
      public observe(): void {
        observers.push(() => this.callback([], this as ResizeObserver));
      }
      public unobserve(): void {}
      public disconnect(): void {}
    } as unknown as typeof ResizeObserver;

    try {
      const mediaDevices = mockMediaDevices({});
      const { rtcSession, matrixRoom } = getBasicRTCSession([local, alice]);
      const { findByTestId, container } = render(
        <BrowserRouter>
          <RootElementProvider value={root}>
            <MediaDevicesContext value={mediaDevices}>
              <ProcessorProvider>
                <TooltipProvider>
                  <RoomContext value={mockLivekitRoom({ localParticipant })}>
                    <ActiveCall
                      client={matrixRoom.client}
                      rtcSession={rtcSession.asMockedSession()}
                      matrixRoom={matrixRoom}
                      muteStates={mockMuteStates()}
                      matrixInfo={matrixInfo}
                      onShareClick={null}
                      e2eeSystem={{ kind: E2eeType.NONE }}
                      onLeft={(): void => {}}
                    />
                  </RoomContext>
                </TooltipProvider>
              </ProcessorProvider>
            </MediaDevicesContext>
          </RootElementProvider>
        </BrowserRouter>,
        { container: root },
      );
      await findByTestId("incall_end_call_menu");
      const call = container.querySelector("[data-layout]")!;
      expect(call.getAttribute("data-layout")).not.toBe("pip");

      // The host shrinks the container to a corner of its page. The window has
      // not changed at all — what matters is the element we were given.
      size = { width: 300, height: 300 };
      act(() => observers.forEach((notify) => notify()));
      expect(call.getAttribute("data-layout")).toBe("pip");

      size = { width: 1000, height: 800 };
      act(() => observers.forEach((notify) => notify()));
      expect(call.getAttribute("data-layout")).not.toBe("pip");
    } finally {
      window.ResizeObserver = originalResizeObserver;
      root.remove();
    }
  });
});
