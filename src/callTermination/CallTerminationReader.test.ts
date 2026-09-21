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
import { describe, expect, test, vi } from "vitest";

import { getBasicRTCSession } from "../utils/test-viewmodel";
import {
  alice,
  aliceDeviceId,
  local,
  localRtcMember,
} from "../utils/test-fixtures";
import { mockRtcMembership, testScope } from "../utils/test";
import { CallTerminationReader } from "./CallTerminationReader";
import { ElementCallTerminateEventType } from ".";

const makeTerminationEvent = ({
  roomId,
  sender,
  eventId = `$terminate-${sender}:example.org`,
  type = ElementCallTerminateEventType,
  originServerTs = 12345,
  content = {
    terminated_by: sender,
    timestamp: 12345,
  },
}: {
  roomId: string;
  sender: string;
  eventId?: string;
  type?: string;
  originServerTs?: number;
  content?: Record<string, unknown>;
}): MatrixEvent =>
  new MatrixEvent({
    room_id: roomId,
    event_id: eventId,
    sender,
    type,
    origin_server_ts: originServerTs,
    content,
  });

function emitTimeline(
  rtcSession: ReturnType<typeof getBasicRTCSession>["rtcSession"],
  event: MatrixEvent,
  options: { liveEvent?: boolean; toStartOfTimeline?: boolean } = {},
): void {
  rtcSession.room.emit(
    MatrixRoomEvent.Timeline,
    event,
    rtcSession.room,
    options.toStartOfTimeline ?? false,
    false,
    {
      liveEvent: options.liveEvent ?? true,
    } as IRoomTimelineData,
  );
}

describe("CallTerminationReader", () => {
  test("emits a live termination event sent by another participant", () => {
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

    emitTimeline(
      rtcSession,
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

    emitTimeline(
      rtcSession,
      makeTerminationEvent({
        roomId: rtcSession.room.roomId,
        sender: localRtcMember.userId,
      }),
    );

    expect(terminations).toStrictEqual([]);
  });

  test.each([
    [{}, "missing fields"],
    [{ terminated_by: 42, timestamp: 12345 }, "wrong terminated_by type"],
    [
      { terminated_by: alice.userId, timestamp: Number.NaN },
      "non-finite timestamp",
    ],
    [{ terminated_by: alice.userId, timestamp: 0 }, "non-positive timestamp"],
    [
      {
        terminated_by: alice.userId,
        timestamp: 12345,
        reason: { invalid: true },
      },
      "wrong reason type",
    ],
  ])("ignores malformed content (%s)", (content, _description) => {
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

    emitTimeline(
      rtcSession,
      makeTerminationEvent({
        roomId: rtcSession.room.roomId,
        sender: alice.userId,
        content,
      }),
    );

    expect(terminations).toStrictEqual([]);
  });

  test("uses the authenticated sender instead of a forged terminated_by", () => {
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

    emitTimeline(
      rtcSession,
      makeTerminationEvent({
        roomId: rtcSession.room.roomId,
        sender: alice.userId,
        content: {
          terminated_by: localRtcMember.userId,
          timestamp: 12345,
        },
      }),
    );

    expect(terminations).toStrictEqual([]);
  });

  test("ignores wrong event types and rooms", () => {
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

    emitTimeline(
      rtcSession,
      makeTerminationEvent({
        roomId: rtcSession.room.roomId,
        sender: alice.userId,
        type: "m.room.message",
      }),
    );
    emitTimeline(
      rtcSession,
      makeTerminationEvent({
        roomId: "!other:example.org",
        sender: alice.userId,
        eventId: "$wrong-room:example.org",
      }),
    );

    expect(terminations).toStrictEqual([]);
  });

  test("uses the deprecated callId only as a scope fallback", () => {
    const { rtcSession } = getBasicRTCSession([local, alice]);
    Object.assign(rtcSession, { callId: "another-call" });
    const reader = new CallTerminationReader(
      testScope(),
      rtcSession.asMockedSession(),
      rtcSession.room.client,
    );
    const terminations: unknown[] = [];
    reader.termination$.subscribe((termination) =>
      terminations.push(termination),
    );

    emitTimeline(
      rtcSession,
      makeTerminationEvent({
        roomId: rtcSession.room.roomId,
        sender: alice.userId,
      }),
    );

    expect(terminations).toStrictEqual([]);
  });

  test("does not admit history, including a later decrypted event", () => {
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
    const event = makeTerminationEvent({
      roomId: rtcSession.room.roomId,
      sender: alice.userId,
      eventId: "$historical:example.org",
    });

    emitTimeline(rtcSession, event, {
      liveEvent: false,
      toStartOfTimeline: true,
    });
    rtcSession.room.client.emit(MatrixEventEvent.Decrypted, event);

    expect(terminations).toStrictEqual([]);
  });

  test("deduplicates an admitted event", () => {
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
    const event = makeTerminationEvent({
      roomId: rtcSession.room.roomId,
      sender: alice.userId,
      eventId: "$duplicate:example.org",
    });

    emitTimeline(rtcSession, event);
    emitTimeline(rtcSession, event);

    expect(terminations).toHaveLength(1);
  });

  test("re-admits an encrypted event only after it decrypts", () => {
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
    const event = new MatrixEvent({
      room_id: rtcSession.room.roomId,
      event_id: "$encrypted:example.org",
      sender: alice.userId,
      type: "m.room.encrypted",
      origin_server_ts: 12345,
      content: { algorithm: "m.megolm.v1.aes-sha2" },
    });
    vi.spyOn(rtcSession.room.client, "decryptEventIfNeeded").mockImplementation(
      async () => {
        event.event.type = ElementCallTerminateEventType;
        event.event.content = {
          terminated_by: alice.userId,
          timestamp: 12345,
        };
        rtcSession.room.client.emit(MatrixEventEvent.Decrypted, event);
        await Promise.resolve();
      },
    );

    emitTimeline(rtcSession, event);

    expect(terminations).toStrictEqual([
      {
        terminatedBy: alice.userId,
        reason: undefined,
        timestamp: 12345,
      },
    ]);
  });

  test("rejects a termination before the observed participant membership", () => {
    const staleMembership = mockRtcMembership(alice.userId, aliceDeviceId, {
      membership: { created_ts: 50000 },
    });
    const { rtcSession } = getBasicRTCSession(
      [local, alice],
      [localRtcMember, staleMembership],
    );
    const reader = new CallTerminationReader(
      testScope(),
      rtcSession.asMockedSession(),
      rtcSession.room.client,
    );
    const terminations: unknown[] = [];
    reader.termination$.subscribe((termination) =>
      terminations.push(termination),
    );

    emitTimeline(
      rtcSession,
      makeTerminationEvent({
        roomId: rtcSession.room.roomId,
        sender: alice.userId,
        originServerTs: 40000,
        content: {
          terminated_by: alice.userId,
          timestamp: 40000,
        },
      }),
    );

    expect(terminations).toStrictEqual([]);
  });

  test("rejects a stale event after the sender rejoins the session", () => {
    const oldMembership = mockRtcMembership(alice.userId, aliceDeviceId, {
      membership: { created_ts: 1000 },
    });
    const newMembership = mockRtcMembership(alice.userId, aliceDeviceId, {
      membership: { created_ts: 5000 },
    });
    const { rtcSession, rtcMemberships$ } = getBasicRTCSession(
      [local, alice],
      [localRtcMember, oldMembership],
    );
    const reader = new CallTerminationReader(
      testScope(),
      rtcSession.asMockedSession(),
      rtcSession.room.client,
    );
    const terminations: unknown[] = [];
    reader.termination$.subscribe((termination) =>
      terminations.push(termination),
    );

    rtcMemberships$.next([localRtcMember]);
    rtcMemberships$.next([localRtcMember, newMembership]);
    emitTimeline(
      rtcSession,
      makeTerminationEvent({
        roomId: rtcSession.room.roomId,
        sender: alice.userId,
        originServerTs: 2000,
        content: {
          terminated_by: alice.userId,
          timestamp: 2000,
        },
      }),
    );

    expect(terminations).toStrictEqual([]);
  });

  test.each([false, true])(
    "rejects an old event after the local device rejoins (encrypted: %s)",
    (encrypted) => {
      const aliceMembership = mockRtcMembership(alice.userId, aliceDeviceId, {
        membership: { created_ts: 1000 },
      });
      const localMembership = (createdTs: number) =>
        mockRtcMembership(localRtcMember.userId, localRtcMember.deviceId, {
          membership: { created_ts: createdTs },
        });
      const { rtcSession, rtcMemberships$ } = getBasicRTCSession(
        [local, alice],
        [localMembership(1000), aliceMembership],
      );
      const reader = new CallTerminationReader(
        testScope(),
        rtcSession.asMockedSession(),
        rtcSession.room.client,
      );
      const terminations: unknown[] = [];
      reader.termination$.subscribe((event) => terminations.push(event));
      const event = makeTerminationEvent({
        roomId: rtcSession.room.roomId,
        sender: alice.userId,
        originServerTs: 3000,
      });
      if (encrypted) {
        event.event.type = "m.room.encrypted";
        emitTimeline(rtcSession, event);
      }
      rtcMemberships$.next([aliceMembership]);
      rtcMemberships$.next([localMembership(5000), aliceMembership]);
      if (encrypted) {
        event.event.type = ElementCallTerminateEventType;
        rtcSession.room.client.emit(MatrixEventEvent.Decrypted, event);
      } else {
        emitTimeline(rtcSession, event);
      }
      expect(terminations).toEqual([]);

      emitTimeline(
        rtcSession,
        makeTerminationEvent({
          roomId: rtcSession.room.roomId,
          sender: alice.userId,
          eventId: "$current-call:example.org",
          originServerTs: 6000,
        }),
      );
      expect(terminations).toHaveLength(1);
    },
  );

  test("keeps a participant eligible after their membership leaves", () => {
    const { rtcSession, rtcMemberships$ } = getBasicRTCSession([local, alice]);
    const reader = new CallTerminationReader(
      testScope(),
      rtcSession.asMockedSession(),
      rtcSession.room.client,
    );
    const terminations: unknown[] = [];
    reader.termination$.subscribe((termination) =>
      terminations.push(termination),
    );
    rtcMemberships$.next([localRtcMember]);

    emitTimeline(
      rtcSession,
      makeTerminationEvent({
        roomId: rtcSession.room.roomId,
        sender: alice.userId,
        originServerTs: Date.now(),
        content: {
          terminated_by: alice.userId,
          timestamp: Date.now(),
        },
      }),
    );

    expect(terminations).toHaveLength(1);
  });

  test("rejects a new event after the departed-sender grace window", () => {
    vi.useFakeTimers();
    try {
      const leftAt = new Date("2026-09-20T00:00:00.000Z");
      vi.setSystemTime(leftAt);
      const { rtcSession, rtcMemberships$ } = getBasicRTCSession([
        local,
        alice,
      ]);
      const reader = new CallTerminationReader(
        testScope(),
        rtcSession.asMockedSession(),
        rtcSession.room.client,
      );
      const terminations: unknown[] = [];
      reader.termination$.subscribe((termination) =>
        terminations.push(termination),
      );

      rtcMemberships$.next([localRtcMember]);
      vi.setSystemTime(leftAt.getTime() + 30_001);
      const timestamp = Date.now();
      emitTimeline(
        rtcSession,
        makeTerminationEvent({
          roomId: rtcSession.room.roomId,
          sender: alice.userId,
          originServerTs: timestamp,
          content: {
            terminated_by: alice.userId,
            timestamp,
          },
        }),
      );

      expect(terminations).toStrictEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("removes all listeners when its scope ends", () => {
    const { rtcSession } = getBasicRTCSession([local, alice]);
    const scope = testScope();
    const reader = new CallTerminationReader(
      scope,
      rtcSession.asMockedSession(),
      rtcSession.room.client,
    );
    const terminations: unknown[] = [];
    reader.termination$.subscribe((termination) =>
      terminations.push(termination),
    );
    scope.end();

    emitTimeline(
      rtcSession,
      makeTerminationEvent({
        roomId: rtcSession.room.roomId,
        sender: alice.userId,
      }),
    );
    rtcSession.room.client.emit(
      MatrixEventEvent.Decrypted,
      makeTerminationEvent({
        roomId: rtcSession.room.roomId,
        sender: alice.userId,
        eventId: "$after-end:example.org",
      }),
    );

    expect(terminations).toStrictEqual([]);
  });
});
