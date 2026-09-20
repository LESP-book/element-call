/*
Copyright 2025 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  Room as LivekitRoom,
  type BaseKeyProvider,
  type RoomOptions,
} from "livekit-client";
import { BehaviorSubject } from "rxjs";
import fetchMock from "fetch-mock";
import { logger } from "matrix-js-sdk/lib/logger";
import EventEmitter from "events";

import { ObservableScope } from "../../ObservableScope.ts";
import { ECConnectionFactory } from "./ConnectionFactory.ts";
import type { OpenIDClientParts } from "../../../livekit/openIDSFU.ts";
import {
  exampleTransport,
  mockMediaDevices,
  ownMemberMock,
} from "../../../utils/test.ts";
import type { ProcessorState } from "../../../livekit/TrackProcessorContext.tsx";
import { constant } from "../../Behavior";
import {
  echoCancellationSetting,
  noiseSuppressionSetting,
  autoGainControlSetting,
  advancedCamera,
  cameraResolution,
  cameraFramerate,
  cameraBitrate,
  cameraCodec,
} from "../../../settings/settings.ts";

// At the top of your test file, after imports
vi.mock("livekit-client", async (importOriginal) => {
  return {
    ...(await importOriginal()),
    Room: vi.fn().mockImplementation(function (this: LivekitRoom, options) {
      const emitter = new EventEmitter();
      return {
        on: emitter.on.bind(emitter),
        off: emitter.off.bind(emitter),
        emit: emitter.emit.bind(emitter),
        disconnect: vi.fn(),
        remoteParticipants: new Map(),
      } as unknown as LivekitRoom;
    }),
  };
});

vi.mock("livekit-client/e2ee-worker?worker&inline", () => ({
  default: vi.fn(),
}));

let testScope: ObservableScope;
let mockClient: OpenIDClientParts;

beforeEach(() => {
  testScope = new ObservableScope();
  mockClient = {
    getOpenIdToken: vi.fn().mockReturnValue(""),
    getDeviceId: vi.fn().mockReturnValue("DEV000"),
  };
});

describe("ECConnectionFactory - Audio inputs options", () => {
  test.each([
    { echo: true, noise: true },
    { echo: true, noise: false },
    { echo: false, noise: true },
    { echo: false, noise: false },
  ])(
    "it sets echoCancellation=$echo and noiseSuppression=$noise based on settings",
    ({ echo, noise }) => {
      const RoomConstructor = vi.mocked(LivekitRoom);

      // Set audio processing settings
      echoCancellationSetting.setValue(echo);
      noiseSuppressionSetting.setValue(noise);

      const ecConnectionFactory = new ECConnectionFactory(
        mockClient,
        "!roomid:example.org",
        mockMediaDevices({}),
        new BehaviorSubject<ProcessorState>({
          supported: true,
          processor: undefined,
        }),
        undefined,
        false,
      );
      ecConnectionFactory.createConnection(
        testScope,
        exampleTransport,
        ownMemberMock,
        logger,
      );

      // Check if Room was constructed with expected options
      expect(RoomConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          audioCaptureDefaults: expect.objectContaining({
            echoCancellation: echo,
            noiseSuppression: noise,
          }),
        }),
      );
    },
  );
});

test("it creates a room when the key provider has a circular reference", () => {
  const info = vi.spyOn(logger, "info").mockImplementation((...args) => {
    // 模拟宿主 WebView 的日志接收器，验证传入参数可以被序列化。
    JSON.stringify(args);
  });
  const circularKeyProvider = Object.assign(
    {} as BaseKeyProvider & { reEmitter: { target?: unknown } },
    { reEmitter: {} },
  );
  circularKeyProvider.reEmitter.target = circularKeyProvider;

  try {
    const RoomConstructor = vi.mocked(LivekitRoom);
    const ecConnectionFactory = new ECConnectionFactory(
      mockClient,
      "!roomid:example.org",
      mockMediaDevices({}),
      new BehaviorSubject<ProcessorState>({
        supported: true,
        processor: undefined,
      }),
      circularKeyProvider,
      false,
    );

    const connection = ecConnectionFactory.createConnection(
      testScope,
      exampleTransport,
      ownMemberMock,
      logger,
    );

    expect(connection.livekitRoom).toBeDefined();
    const roomOptions = RoomConstructor.mock.calls[
      RoomConstructor.mock.calls.length - 1
    ]?.[0] as RoomOptions;
    expect(roomOptions.e2ee?.keyProvider).toBe(circularKeyProvider);
    expect(info).toHaveBeenCalledWith(
      "[ECConnectionFactory] livekit room options:",
      { e2eeEnabled: true, controlledAudioDevices: false },
    );
  } finally {
    info.mockRestore();
  }
});

describe("ECConnectionFactory - ControlledAudioDevice", () => {
  test.each([{ controlled: true }, { controlled: false }])(
    "it sets controlledAudioDevice=$controlled then uses deviceId accordingly",
    ({ controlled }) => {
      const RoomConstructor = vi.mocked(LivekitRoom);

      // Explicitly set audio settings so the test doesn't depend on defaults
      echoCancellationSetting.setValue(true);
      noiseSuppressionSetting.setValue(true);
      autoGainControlSetting.setValue(true);

      const ecConnectionFactory = new ECConnectionFactory(
        mockClient,
        "!roomid:example.org",
        mockMediaDevices({
          audioOutput: {
            available$: constant(new Map<never, never>()),
            selected$: constant({ id: "DEV00", virtualEarpiece: false }),
            select: () => {},
          },
        }),
        new BehaviorSubject<ProcessorState>({
          supported: true,
          processor: undefined,
        }),
        undefined,
        controlled,
      );
      ecConnectionFactory.createConnection(
        testScope,
        exampleTransport,
        ownMemberMock,
        logger,
      );

      // Check if Room was constructed with expected options
      expect(RoomConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          audioOutput: expect.objectContaining({
            deviceId: controlled ? undefined : "DEV00",
          }),
        }),
      );
    },
  );
});

describe("ECConnectionFactory - Camera quality settings", () => {
  test("it uses default video options when advancedCamera is disabled", () => {
    const RoomConstructor = vi.mocked(LivekitRoom);
    advancedCamera.setValue(false);

    const ecConnectionFactory = new ECConnectionFactory(
      mockClient,
      "!roomid:example.org",
      mockMediaDevices({}),
      new BehaviorSubject<ProcessorState>({
        supported: true,
        processor: undefined,
      }),
      undefined,
      false,
    );
    ecConnectionFactory.createConnection(
      testScope,
      exampleTransport,
      ownMemberMock,
      logger,
    );

    // publishDefaults should use config defaults (vp8), not custom settings
    expect(RoomConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        publishDefaults: expect.objectContaining({
          videoCodec: "vp8",
        }),
      }),
    );
  });

  test("it applies custom camera resolution, encoding, and codec when advancedCamera is enabled", () => {
    const RoomConstructor = vi.mocked(LivekitRoom);

    advancedCamera.setValue(true);
    cameraResolution.setValue("1920x1080");
    cameraFramerate.setValue(60);
    cameraBitrate.setValue(4_000_000);
    cameraCodec.setValue("vp9");

    const ecConnectionFactory = new ECConnectionFactory(
      mockClient,
      "!roomid:example.org",
      mockMediaDevices({}),
      new BehaviorSubject<ProcessorState>({
        supported: true,
        processor: undefined,
      }),
      undefined,
      false,
    );
    ecConnectionFactory.createConnection(
      testScope,
      exampleTransport,
      ownMemberMock,
      logger,
    );

    expect(RoomConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        videoCaptureDefaults: expect.objectContaining({
          resolution: { width: 1920, height: 1080, frameRate: 60 },
        }),
        publishDefaults: expect.objectContaining({
          videoEncoding: { maxBitrate: 4_000_000, maxFramerate: 60 },
          videoCodec: "vp9",
        }),
      }),
    );
  });

  test("it applies autoGainControl from settings", () => {
    const RoomConstructor = vi.mocked(LivekitRoom);

    autoGainControlSetting.setValue(false);
    echoCancellationSetting.setValue(true);
    noiseSuppressionSetting.setValue(true);

    const ecConnectionFactory = new ECConnectionFactory(
      mockClient,
      "!roomid:example.org",
      mockMediaDevices({}),
      new BehaviorSubject<ProcessorState>({
        supported: true,
        processor: undefined,
      }),
      undefined,
      false,
    );
    ecConnectionFactory.createConnection(
      testScope,
      exampleTransport,
      ownMemberMock,
      logger,
    );

    expect(RoomConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        audioCaptureDefaults: expect.objectContaining({
          autoGainControl: false,
        }),
      }),
    );
  });
});

afterEach(() => {
  testScope.end();
  fetchMock.reset();
});
