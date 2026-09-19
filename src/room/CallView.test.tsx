/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// TODO-MULTI-SFU: Restore or discard these tests. The role of CallView has
// changed (it no longer manages the connection to the same extent), so they may
// need extra work to adapt.

import {
  beforeEach,
  expect,
  type MockedFunction,
  onTestFinished,
  test,
  vi,
  vitest,
} from "vitest";
import { render, waitFor, screen, act } from "@testing-library/react";
import {
  type MatrixClient,
  JoinRule,
  type RoomState,
  UnsupportedStickyEventsEndpointError,
} from "matrix-js-sdk";
import {
  MatrixRTCSessionEvent,
  type MatrixRTCSession,
} from "matrix-js-sdk/lib/matrixrtc";
import { BrowserRouter } from "react-router-dom";
import userEvent, {
  PointerEventsCheckLevel,
} from "@testing-library/user-event";
import { type RelationsContainer } from "matrix-js-sdk/lib/models/relations-container";
import { type JSX, useState } from "react";
import { TooltipProvider } from "@vector-im/compound-web";
import { NEVER, Subject } from "rxjs";
import { Room as LivekitRoom } from "livekit-client";

import { prefetchSounds } from "../soundUtils";
import { useAudioContext } from "../useAudioContext";
import { ActiveCall } from "./InCallView";
import {
  flushPromises,
  mockEmitter,
  mockMatrixRoom,
  mockMatrixRoomMember,
  mockMediaDevices,
  mockRtcMembership,
  MockRTCSession,
} from "../utils/test";
import { CallView } from "./CallView";
import { GroupCallErrorBoundary } from "./GroupCallErrorBoundary";
import {
  type HostBridge,
  HostBridgeProvider,
  type HostRequest,
  nullHostBridge,
} from "../HostBridge";
import { type JoinCallData } from "../widget";
import { MatrixRTCTransportMissingError } from "../utils/errors";
import { ProcessorProvider } from "../livekit/TrackProcessorContext";
import { MediaDevicesContext } from "../MediaDevicesContext";
import { constant } from "../state/Behavior";
import { type MediaDevices } from "../state/MediaDevices";

vi.mock("../soundUtils");
vi.mock("../useAudioContext");
vi.mock("./InCallView");
const previewTracks = vi.hoisted(() => ({
  value: [] as unknown[] | undefined,
  onError: undefined as ((error: Error) => void) | undefined,
}));
vi.mock("@livekit/components-react", () => ({
  usePreviewTracks: (
    _options: unknown,
    onError?: (error: Error) => void,
  ): unknown[] | undefined => {
    previewTracks.onError = onError;
    return previewTracks.value;
  },
}));
vi.mock("react-use-measure", () => ({
  default: (): [() => void, object] => [(): void => {}, {}],
}));

vi.hoisted(
  () =>
    // Use globalThis rather than global because vite-plugin-node-polyfills seems
    // to rewrite global into an import which then interferes with vitest's hoisting
    // which runs before imports.
    (globalThis.ImageData = class MockImageData {
      public data: number[] = [];
    } as unknown as typeof ImageData),
);

const enterRTCSession = vi.hoisted(() => vi.fn(async () => Promise.resolve()));
const leaveRTCSession = vi.hoisted(() =>
  vi.fn(
    async (
      rtcSession: unknown,
      cause: unknown,
      promiseBeforeHangup = Promise.resolve(),
    ) => await promiseBeforeHangup,
  ),
);

// vi.mock("../rtcSessionHelpers", async (importOriginal) => {
//   // TODO: perhaps there is a more elegant way to manage the type import here?
//   // eslint-disable-next-line @typescript-eslint/consistent-type-imports
//   const orig = await importOriginal<typeof import("../rtcSessionHelpers")>();
//   // TODO: leaveRTCSession no longer exists! Tests need adapting.
//   return { ...orig, enterRTCSession, leaveRTCSession };
// });

let playSound: MockedFunction<
  NonNullable<ReturnType<typeof useAudioContext>>["playSound"]
>;
let activeCallInstanceSeed = 0;

const localRtcMember = mockRtcMembership("@carol:example.org", "CCCC");
const carol = mockMatrixRoomMember(localRtcMember);
const roomMembers = new Map([carol].map((p) => [p.userId, p]));

const roomId = "!foo:bar";

beforeEach(() => {
  vi.clearAllMocks();
  previewTracks.value = [];
  previewTracks.onError = undefined;
  activeCallInstanceSeed = 0;
  (prefetchSounds as MockedFunction<typeof prefetchSounds>).mockResolvedValue({
    sound: new ArrayBuffer(0),
  });
  playSound = vi.fn();
  (useAudioContext as MockedFunction<typeof useAudioContext>).mockReturnValue({
    playSound,
    playSoundLooping: vi.fn(),
    soundDuration: {},
  });
  // A trivial implementation of Active call to ensure we are testing CallView exclusively here.
  (ActiveCall as MockedFunction<typeof ActiveCall>).mockImplementation(
    ({ onLeft: onLeave }) => {
      const [instanceId] = useState(() => ++activeCallInstanceSeed);
      return (
        <div>
          <div data-testid="active_call_instance">{instanceId}</div>
          <button onClick={() => onLeave("user")}>Leave</button>
          <button onClick={() => onLeave("allOthersLeft")}>
            SimulateOtherLeft
          </button>
          <button onClick={() => onLeave("error")}>SimulateErrorLeft</button>
        </div>
      );
    },
  );
});

function createCallView(
  hostBridge: HostBridge,
  joined = true,
  options: {
    withErrorBoundary?: boolean;
    /** Wait for the host to say when to join, rather than joining at once. */
    preload?: boolean;
    mediaDevices?: MediaDevices;
  } = {},
): ReturnType<typeof render> & {
  rtcSession: MatrixRTCSession;
  refresh: () => void;
} {
  const client = {
    getUser: () => null,
    getUserId: () => localRtcMember.userId,
    getDeviceId: () => localRtcMember.deviceId,
    getRoom: (rId) => (rId === roomId ? room : null),
  } as Partial<MatrixClient> as MatrixClient;
  const room = mockMatrixRoom({
    relations: {
      getChildEventsForEvent: () =>
        vi.mocked({
          getRelations: () => [],
        }),
    } as unknown as RelationsContainer,
    client,
    roomId,
    getMember: (userId) => roomMembers.get(userId) ?? null,
    getMxcAvatarUrl: () => null,
    getCanonicalAlias: () => null,
    currentState: {
      ...mockEmitter(),
      getJoinRule: () => JoinRule.Invite,
    } as Partial<RoomState> as RoomState,
  });
  const rtcSession = new MockRTCSession(room, []).withMemberships(
    constant([localRtcMember]),
  );
  rtcSession.joined = joined;
  const callView = (): JSX.Element => (
    <CallView
      client={client}
      isPasswordlessUser={false}
      confineToRoom={false}
      preload={options.preload ?? false}
      // Straight into the (mocked) call, past the lobby
      skipLobby
      rtcSession={rtcSession.asMockedSession()}
    />
  );
  const renderCallView = (): JSX.Element => (
    <BrowserRouter>
      <HostBridgeProvider value={hostBridge}>
        <TooltipProvider>
          <MediaDevicesContext
            value={options.mediaDevices ?? mockMediaDevices({})}
          >
            <ProcessorProvider>
              {options.withErrorBoundary ? (
                <GroupCallErrorBoundary recoveryActionHandler={vi.fn()}>
                  {callView()}
                </GroupCallErrorBoundary>
              ) : (
                callView()
              )}
            </ProcessorProvider>
          </MediaDevicesContext>
        </TooltipProvider>
      </HostBridgeProvider>
    </BrowserRouter>
  );
  const result = render(renderCallView());
  return {
    ...result,
    rtcSession: rtcSession.asMockedSession(),
    refresh: () => result.rerender(renderCallView()),
  };
}

test("waits for media permission before entering a call without a lobby", async () => {
  previewTracks.value = undefined;
  const hostBridge: HostBridge = {
    ...nullHostBridge,
    allowJoinUnmutedViaIntent: true,
  };
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
  });

  const { refresh } = createCallView(hostBridge, false, { mediaDevices });
  await flushPromises();
  expect(screen.queryByText("Leave")).toBeNull();

  previewTracks.value = [];
  refresh();

  await waitFor(() => expect(screen.getByText("Leave")).toBeInTheDocument());
});

test("enters a direct call muted after media permission is rejected", async () => {
  previewTracks.value = undefined;
  const hostBridge: HostBridge = {
    ...nullHostBridge,
    allowJoinUnmutedViaIntent: true,
  };
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
  });

  createCallView(hostBridge, false, { mediaDevices });
  await flushPromises();
  expect(screen.queryByText("Leave")).toBeNull();

  act(() => previewTracks.onError?.(new Error("Permission denied")));

  await waitFor(() => expect(screen.getByText("Leave")).toBeInTheDocument());
});

test("does not request media before entering a fully muted direct call", async () => {
  previewTracks.value = undefined;

  createCallView(nullHostBridge, false);

  await waitFor(() => expect(screen.getByText("Leave")).toBeInTheDocument());
});

test.skip("CallView plays a leave sound asynchronously in SPA mode", async () => {
  const user = userEvent.setup();
  const { getByText, rtcSession } = createCallView(nullHostBridge);
  const leaveButton = getByText("Leave");
  await user.click(leaveButton);
  expect(playSound).toHaveBeenCalledWith("left");
  expect(leaveRTCSession).toHaveBeenCalledWith(
    rtcSession,
    "user",
    expect.any(Promise),
  );
  expect(leaveRTCSession).toHaveBeenCalledOnce();
  // Ensure that the playSound promise resolves within this test to avoid
  // impacting the results of other tests
  await waitFor(() => expect(leaveRTCSession).toHaveResolved());
});

test.skip("CallView plays a leave sound synchronously in widget mode", async () => {
  const user = userEvent.setup();
  const hostBridge: HostBridge = { ...nullHostBridge, close: vi.fn() };
  let resolvePlaySound: () => void;
  playSound = vi
    .fn()
    .mockReturnValue(
      new Promise<void>((resolve) => (resolvePlaySound = resolve)),
    );
  (useAudioContext as MockedFunction<typeof useAudioContext>).mockReturnValue({
    playSound,
    playSoundLooping: vitest.fn(),
    soundDuration: {},
  });

  const { getByText, rtcSession } = createCallView(hostBridge);
  const leaveButton = getByText("Leave");
  await user.click(leaveButton);
  await flushPromises();
  expect(leaveRTCSession).not.toHaveResolved();
  resolvePlaySound!();
  await flushPromises();

  expect(playSound).toHaveBeenCalledWith("left");
  expect(leaveRTCSession).toHaveBeenCalledWith(
    rtcSession,
    "user",
    expect.any(Promise),
  );
  expect(leaveRTCSession).toHaveBeenCalledOnce();
});

test("Should ask the host to close when all other left and play a sound", async () => {
  const user = userEvent.setup();
  const close = vi.fn().mockResolvedValue(undefined);
  const hostBridge: HostBridge = {
    ...nullHostBridge,
    setAlwaysOnScreen: vi.fn().mockResolvedValue(undefined),
    close,
  };
  const resolvePlaySound = Promise.withResolvers<void>();
  playSound = vi.fn().mockReturnValue(resolvePlaySound.promise);
  (useAudioContext as MockedFunction<typeof useAudioContext>).mockReturnValue({
    playSound,
    playSoundLooping: vitest.fn(),
    soundDuration: {},
  });

  const { getByText } = createCallView(hostBridge);
  const leaveButton = getByText("SimulateOtherLeft");
  await user.click(leaveButton);
  await flushPromises();
  expect(close).not.toHaveBeenCalled();
  resolvePlaySound.resolve();

  expect(playSound).toHaveBeenCalledWith("left", 0);
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
}, 80000);

test("Waits for the host to say when to join, when preloaded", async () => {
  // Nothing to match device names against; the host names none anyway
  vi.spyOn(LivekitRoom, "getLocalDevices").mockResolvedValue([]);
  const join$ = new Subject<HostRequest<JoinCallData>>();
  const hostBridge: HostBridge = { ...nullHostBridge, join$ };

  createCallView(hostBridge, false, { preload: true });
  await flushPromises();
  // Past the lobby, but not in the call: the host has not asked yet
  expect(screen.queryByText("Leave")).toBeNull();

  const reply = vi.fn();
  act(() =>
    join$.next({ data: { audioInput: null, videoInput: null }, reply }),
  );
  // Then in the call, and the host told so
  await waitFor(() => expect(reply).toHaveBeenCalledOnce());
  expect(screen.getByText("Leave")).toBeInTheDocument();
});

test("Should not ask the host to close when auto leave due to error", async () => {
  const user = userEvent.setup();

  const close = vi.fn().mockResolvedValue(undefined);
  const setAlwaysOnScreen = vi.fn().mockResolvedValue(undefined);
  const hostBridge: HostBridge = {
    ...nullHostBridge,
    setAlwaysOnScreen,
    close,
  };

  const { getByText } = createCallView(hostBridge);
  const leaveButton = getByText("SimulateErrorLeft");
  await user.click(leaveButton);
  await flushPromises();

  // When onLeft is called, we first set always on screen to false
  await waitFor(() => expect(setAlwaysOnScreen).toHaveBeenCalledWith(false));
  await flushPromises();
  // But then we do not ask to be closed automatically
  expect(close).not.toHaveBeenCalled();
});

test.skip("CallView leaves the session when an error occurs", async () => {
  (ActiveCall as MockedFunction<typeof ActiveCall>).mockImplementation(() => {
    const [error, setError] = useState<Error | null>(null);
    if (error !== null) throw error;
    return (
      <div>
        <button onClick={() => setError(new Error())}>Panic!</button>
      </div>
    );
  });
  const user = userEvent.setup();
  const { rtcSession } = createCallView(nullHostBridge);
  await user.click(screen.getByRole("button", { name: "Panic!" }));
  screen.getByText("Something went wrong");
  expect(leaveRTCSession).toHaveBeenCalledWith(
    rtcSession,
    "error",
    expect.any(Promise),
  );
});

test.skip("CallView shows errors that occur during joining", async () => {
  const user = userEvent.setup();
  // This should not mock this error that deep. it should only mock the CallViewModel.
  enterRTCSession.mockRejectedValue(new MatrixRTCTransportMissingError(""));
  onTestFinished(() => {
    enterRTCSession.mockReset();
  });
  createCallView(nullHostBridge, false);
  await user.click(screen.getByRole("button", { name: "Join call" }));
  screen.getByText("Call is not supported");
});

test("translates wrapped UnsupportedStickyEventsEndpointError to the StickyEventsRequiredError screen", async () => {
  // Mirror the shape the SDK emits: the MembershipManager scheduler wraps
  // the original UnsupportedStickyEventsEndpointError in a generic Error
  // but preserves the original on `.cause`.
  const stickyError = new UnsupportedStickyEventsEndpointError(
    "Server does not support the sticky events",
    "sendStickyEvent",
  );
  const wrappedError = new Error(
    "The MembershipManager shut down because of the end condition: " +
      String(stickyError),
    { cause: stickyError },
  );

  const { rtcSession } = createCallView(nullHostBridge, true, {
    withErrorBoundary: true,
  });

  await act(() =>
    rtcSession.emit(MatrixRTCSessionEvent.MembershipManagerError, wrappedError),
  );

  await screen.findByText("Homeserver does not support Matrix 2.0 calls");
});

test("shows ConnectionLostError after automatic recovery attempts are exhausted", async () => {
  const { rtcSession } = createCallView(nullHostBridge, true, {
    withErrorBoundary: true,
  });

  await waitFor(() =>
    expect(screen.getByTestId("active_call_instance")).toHaveTextContent("1"),
  );
  for (const expectedInstance of ["2", "3", "4"]) {
    await act(() =>
      rtcSession.emit(
        MatrixRTCSessionEvent.MembershipManagerError,
        new Error("something else broke"),
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("active_call_instance")).toHaveTextContent(
        expectedInstance,
      ),
    );
  }

  await act(() =>
    rtcSession.emit(
      MatrixRTCSessionEvent.MembershipManagerError,
      new Error("something else broke"),
    ),
  );

  await screen.findByText("Connection lost");
});

test("user can reconnect after automatic recovery attempts are exhausted", async () => {
  const user = userEvent.setup({
    pointerEventsCheck: PointerEventsCheckLevel.Never,
  });
  const { rtcSession } = createCallView(nullHostBridge, true);

  await waitFor(() =>
    expect(screen.getByTestId("active_call_instance")).toHaveTextContent("1"),
  );
  for (const expectedInstance of ["2", "3", "4"]) {
    await act(() =>
      rtcSession.emit(MatrixRTCSessionEvent.MembershipManagerError, undefined),
    );
    await waitFor(() =>
      expect(screen.getByTestId("active_call_instance")).toHaveTextContent(
        expectedInstance,
      ),
    );
  }

  await act(() =>
    rtcSession.emit(MatrixRTCSessionEvent.MembershipManagerError, undefined),
  );
  await waitFor(() => screen.getByRole("button", { name: "Reconnect" }));
  await act(async () => {
    await user.click(screen.getByRole("button", { name: "Reconnect" }));
  });
  await waitFor(() => screen.getByRole("button", { name: "Leave" }));
});

test("automatically reconnects up to three times after membership manager errors", async () => {
  const { rtcSession } = createCallView(nullHostBridge, true);

  await waitFor(() =>
    expect(screen.getByTestId("active_call_instance")).toHaveTextContent("1"),
  );
  await act(() =>
    rtcSession.emit(MatrixRTCSessionEvent.MembershipManagerError, undefined),
  );
  await waitFor(() =>
    expect(screen.getByTestId("active_call_instance")).toHaveTextContent("2"),
  );
  await act(() =>
    rtcSession.emit(MatrixRTCSessionEvent.MembershipManagerError, undefined),
  );
  await waitFor(() =>
    expect(screen.getByTestId("active_call_instance")).toHaveTextContent("3"),
  );
  await act(() =>
    rtcSession.emit(MatrixRTCSessionEvent.MembershipManagerError, undefined),
  );
  await waitFor(() =>
    expect(screen.getByTestId("active_call_instance")).toHaveTextContent("4"),
  );
  expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
});

test("user can reconnect manually after three automatic reconnect attempts are exhausted", async () => {
  const user = userEvent.setup({
    // With css vitest turned on this test thinks that the button has pointer_events: none;.
    // TODO investigate if this is a test setup issue or an actual problem.
    pointerEventsCheck: PointerEventsCheckLevel.Never,
  });
  const { rtcSession } = createCallView(nullHostBridge, true);

  await waitFor(() =>
    expect(screen.getByTestId("active_call_instance")).toHaveTextContent("1"),
  );
  await act(() =>
    rtcSession.emit(MatrixRTCSessionEvent.MembershipManagerError, undefined),
  );
  await waitFor(() =>
    expect(screen.getByTestId("active_call_instance")).toHaveTextContent("2"),
  );
  await act(() =>
    rtcSession.emit(MatrixRTCSessionEvent.MembershipManagerError, undefined),
  );
  await waitFor(() =>
    expect(screen.getByTestId("active_call_instance")).toHaveTextContent("3"),
  );
  await act(() =>
    rtcSession.emit(MatrixRTCSessionEvent.MembershipManagerError, undefined),
  );
  await waitFor(() =>
    expect(screen.getByTestId("active_call_instance")).toHaveTextContent("4"),
  );
  await act(() =>
    rtcSession.emit(MatrixRTCSessionEvent.MembershipManagerError, undefined),
  );
  await waitFor(() => screen.getByRole("button", { name: "Reconnect" }));
  await act(async () =>
    user.click(screen.getByRole("button", { name: "Reconnect" })),
  );
  await waitFor(() =>
    expect(screen.getByTestId("active_call_instance")).toHaveTextContent("5"),
  );
});

test("successful recovery resets the automatic reconnect budget", async () => {
  const user = userEvent.setup({
    // With css vitest turned on this test thinks that the button has pointer_events: none;.
    // TODO investigate if this is a test setup issue or an actual problem.
    pointerEventsCheck: PointerEventsCheckLevel.Never,
  });
  const { rtcSession } = createCallView(nullHostBridge, true);

  await waitFor(() =>
    expect(screen.getByTestId("active_call_instance")).toHaveTextContent("1"),
  );

  for (const expectedInstance of ["2", "3", "4"]) {
    await act(() =>
      rtcSession.emit(MatrixRTCSessionEvent.MembershipManagerError, undefined),
    );
    await waitFor(() =>
      expect(screen.getByTestId("active_call_instance")).toHaveTextContent(
        expectedInstance,
      ),
    );
  }

  await act(() =>
    rtcSession.emit(MatrixRTCSessionEvent.MembershipManagerError, undefined),
  );
  await waitFor(() => screen.getByRole("button", { name: "Reconnect" }));

  await act(async () =>
    user.click(screen.getByRole("button", { name: "Reconnect" })),
  );
  await waitFor(() =>
    expect(screen.getByTestId("active_call_instance")).toHaveTextContent("5"),
  );

  await act(() =>
    rtcSession.emit(MatrixRTCSessionEvent.MembershipManagerError, undefined),
  );
  await waitFor(() =>
    expect(screen.getByTestId("active_call_instance")).toHaveTextContent("6"),
  );
  expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
});
