/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  type IRoomTimelineData,
  MatrixEvent,
  MatrixEventEvent,
  RoomEvent as MatrixRoomEvent,
} from "matrix-js-sdk";
import { describe, expect, test } from "vitest";

import { getBasicRTCSession } from "../utils/test-viewmodel";
import { alice, local, localRtcMember } from "../utils/test-fixtures";
import { testScope } from "../utils/test";
import { CallTerminationReader } from "./CallTerminationReader";
import { ElementCallTerminateEventType } from ".";

const makeTerminationEvent = ({
  roomId,
  sender,
  content = {
    terminated_by: sender,
    timestamp: 12345,
  },
}: {
  roomId: string;
  sender: string;
  content?: Record<string, unknown>;
}): MatrixEvent =>
  new MatrixEvent({
    room_id: roomId,
    event_id: `$terminate-${sender}:example.org`,
    sender,
    type: ElementCallTerminateEventType,
    content,
  });

describe("CallTerminationReader", () => {
  test("emits termination events sent by another user", () => {
    const { rtcSession } = getBasicRTCSession([local, alice]);
    const reader = new CallTerminationReader(
      testScope(),
      rtcSession.asMockedSession(),
      rtcSession.room.client,
    );
    const terminations: unknown[] = [];
    reader.termination$.subscribe((termination) =>
      terminations.push(termination),
    );

    rtcSession.room.emit(
      MatrixRoomEvent.Timeline,
      makeTerminationEvent({
        roomId: rtcSession.room.roomId,
        sender: alice.userId,
      }),
      rtcSession.room,
      undefined,
      false,
      {} as IRoomTimelineData,
    );

    expect(terminations).toStrictEqual([
      {
        terminatedBy: alice.userId,
        reason: undefined,
        timestamp: 12345,
      },
    ]);
  });

  test("ignores termination events sent by the local user", () => {
    const { rtcSession } = getBasicRTCSession([local, alice]);
    const reader = new CallTerminationReader(
      testScope(),
      rtcSession.asMockedSession(),
      rtcSession.room.client,
    );
    const terminations: unknown[] = [];
    reader.termination$.subscribe((termination) =>
      terminations.push(termination),
    );

    rtcSession.room.emit(
      MatrixRoomEvent.Timeline,
      makeTerminationEvent({
        roomId: rtcSession.room.roomId,
        sender: localRtcMember.userId,
      }),
      rtcSession.room,
      undefined,
      false,
      {} as IRoomTimelineData,
    );

    expect(terminations).toStrictEqual([]);
  });

  test("ignores termination events with invalid content", () => {
    const { rtcSession } = getBasicRTCSession([local, alice]);
    const reader = new CallTerminationReader(
      testScope(),
      rtcSession.asMockedSession(),
      rtcSession.room.client,
    );
    const terminations: unknown[] = [];
    reader.termination$.subscribe((termination) =>
      terminations.push(termination),
    );

    rtcSession.room.emit(
      MatrixRoomEvent.Timeline,
      makeTerminationEvent({
        roomId: rtcSession.room.roomId,
        sender: alice.userId,
        content: {},
      }),
      rtcSession.room,
      undefined,
      false,
      {} as IRoomTimelineData,
    );

    expect(terminations).toStrictEqual([]);
  });

  test("emits termination events from decrypted Matrix events", () => {
    const { rtcSession } = getBasicRTCSession([local, alice]);
    const reader = new CallTerminationReader(
      testScope(),
      rtcSession.asMockedSession(),
      rtcSession.room.client,
    );
    const terminations: unknown[] = [];
    reader.termination$.subscribe((termination) =>
      terminations.push(termination),
    );

    rtcSession.room.client.emit(
      MatrixEventEvent.Decrypted,
      makeTerminationEvent({
        roomId: rtcSession.room.roomId,
        sender: alice.userId,
      }),
    );

    expect(terminations).toStrictEqual([
      {
        terminatedBy: alice.userId,
        reason: undefined,
        timestamp: 12345,
      },
    ]);
  });
});
