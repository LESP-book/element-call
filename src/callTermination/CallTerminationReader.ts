/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  type IRoomTimelineData,
  type MatrixClient,
  type MatrixEvent,
  MatrixEventEvent,
  RoomEvent as MatrixRoomEvent,
  type Room as MatrixRoom,
} from "matrix-js-sdk";
import { logger } from "matrix-js-sdk/lib/logger";
import {
  type CallMembership,
  MatrixRTCSessionEvent,
  type MatrixRTCSession,
} from "matrix-js-sdk/lib/matrixrtc";
import { Subject } from "rxjs";

import {
  ElementCallTerminateEventType,
  type CallTerminateEventContent,
  type TerminationEvent,
} from ".";
import { type ObservableScope } from "../state/ObservableScope";

/**
 * A sender which has just left may still have a termination event in flight.
 * Keep that sender eligible briefly, but do not grant an old participant
 * indefinite authority over a later call occurrence.
 */
const DEPARTED_PARTICIPANT_GRACE_MS = 30_000;
/** Allow small client/server clock and event-loop skew at the leave boundary. */
const DEPARTED_EVENT_CLOCK_SKEW_MS = 5_000;
/** Bound encrypted events waiting for a Decrypted callback. */
const MAX_PENDING_EVENT_IDS = 256;
const MAX_EMITTED_EVENT_IDS = 256;
const MAX_DEPARTED_MEMBERSHIPS = 256;

type ObservedMembership = {
  userId: string;
  createdTs?: number;
  leftAt?: number;
};

/**
 * Parses the custom termination payload without making decisions about the
 * current call. The authenticated Matrix sender supplies the identity.
 */
function parseTerminationEvent(
  event: MatrixEvent,
  sender: string,
): TerminationEvent | undefined {
  if (event.getType() !== ElementCallTerminateEventType || event.isState()) {
    return undefined;
  }

  const eventTimestamp = event.getTs();
  const content = event.getContent() as unknown as CallTerminateEventContent;
  if (
    !isPositiveFiniteNumber(eventTimestamp) ||
    typeof content.terminated_by !== "string" ||
    content.terminated_by.length === 0 ||
    content.terminated_by !== sender ||
    !isPositiveFiniteNumber(content.timestamp) ||
    (content.reason !== undefined && typeof content.reason !== "string")
  ) {
    return undefined;
  }

  return {
    terminatedBy: sender,
    reason: content.reason,
    timestamp: content.timestamp,
  };
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function membershipKey(membership: CallMembership): string {
  return `${membership.userId}\u0000${membership.eventId}`;
}

/**
 * MatrixRTCSession.memberships is already scoped by the SDK. When an SDK
 * exposes a scope, use it to reject a membership from another slot; use the
 * deprecated callId only as a legacy scope fallback. If neither is available,
 * there is no safe epoch to invent, so retain the SDK's scoped-membership
 * contract rather than broadening it with room membership data.
 */
function membershipBelongsToSession(
  membership: CallMembership,
  rtcSession: MatrixRTCSession,
): boolean {
  const slotId = rtcSession.slotId;
  if (slotId !== undefined) return membership.slotId === slotId;

  const callId = rtcSession.callId;
  if (callId === undefined) return true;
  return (
    membership.slotId === `m.call#${callId}` ||
    (callId === "" && membership.slotId === "m.call#ROOM")
  );
}

/**
 * Listens for call termination events from a RTCSession and emits
 * termination events for consumption by the CallViewModel.
 *
 * A termination is admitted only when it arrived as a live event, belongs to
 * this room, has a valid sender-bound payload, and was sent by a participant
 * observed in this MatrixRTC session. A short departed-participant grace
 * period covers the normal send-then-leave ordering without treating everyone
 * who ever joined as permanently authorised.
 *
 * When another participant sends an `io.element.call.terminate` event,
 * all other participants should automatically leave the call.
 */
export class CallTerminationReader {
  private readonly terminationSubject$ = new Subject<TerminationEvent>();
  private readonly emittedEventIds = new Set<string>();
  private readonly liveEventIds = new Set<string>();
  private readonly observedMemberships = new Map<string, ObservedMembership>();
  private localJoinedAt: number | undefined;

  /**
   * Emits when the call is terminated by another participant.
   * Does not emit for events sent by the local user.
   */
  public readonly termination$ = this.terminationSubject$.asObservable();

  public constructor(
    private readonly scope: ObservableScope,
    private readonly rtcSession: MatrixRTCSession,
    private readonly client: MatrixClient,
  ) {
    this.observeMemberships(this.rtcSession.memberships);
    this.rtcSession.on(
      MatrixRTCSessionEvent.MembershipsChanged,
      this.handleMembershipsChanged,
    );
    this.scope.onEnd(() =>
      this.rtcSession.off(
        MatrixRTCSessionEvent.MembershipsChanged,
        this.handleMembershipsChanged,
      ),
    );

    // `liveEvent` excludes back-pagination and cache insertion. A decrypted
    // event is accepted later only when this live timeline pass remembered its
    // event ID.
    this.rtcSession.room.on(MatrixRoomEvent.Timeline, this.handleTimelineEvent);
    this.scope.onEnd(() =>
      this.rtcSession.room.off(
        MatrixRoomEvent.Timeline,
        this.handleTimelineEvent,
      ),
    );

    this.rtcSession.room.client.on(
      MatrixEventEvent.Decrypted,
      this.handleDecryptedEvent,
    );
    this.scope.onEnd(() =>
      this.rtcSession.room.client.off(
        MatrixEventEvent.Decrypted,
        this.handleDecryptedEvent,
      ),
    );
  }

  private handleMembershipsChanged = (
    _oldMemberships: CallMembership[],
    memberships: CallMembership[],
  ): void => {
    this.observeMemberships(memberships);
  };

  private observeMemberships(memberships: CallMembership[]): void {
    const now = Date.now();
    this.pruneDepartedMemberships(now);
    const currentKeys = new Set<string>();

    for (const membership of memberships) {
      if (!membershipBelongsToSession(membership, this.rtcSession)) continue;

      const key = membershipKey(membership);
      currentKeys.add(key);
      const createdTs = membership.createdTs();
      // A live timeline insertion (including delayed decryption) can belong to
      // our previous join. Use this device's membership, not another device of
      // the same account, and never move the admission boundary backwards.
      if (
        membership.userId === this.client.getUserId() &&
        membership.deviceId === this.client.getDeviceId() &&
        isPositiveFiniteNumber(createdTs)
      ) {
        this.localJoinedAt = Math.max(
          this.localJoinedAt ?? createdTs,
          createdTs,
        );
      }
      this.observedMemberships.set(key, {
        userId: membership.userId,
        createdTs: isPositiveFiniteNumber(createdTs) ? createdTs : undefined,
        // A membership which is present again is current, not departed.
        leftAt: undefined,
      });
    }

    for (const [key, observed] of this.observedMemberships) {
      if (currentKeys.has(key)) continue;
      if (observed.leftAt === undefined) observed.leftAt = now;
    }
  }

  private pruneDepartedMemberships(now: number): void {
    const departed: Array<[string, number]> = [];
    for (const [key, observed] of this.observedMemberships) {
      if (observed.leftAt === undefined) continue;
      if (now - observed.leftAt > DEPARTED_PARTICIPANT_GRACE_MS) {
        this.observedMemberships.delete(key);
        continue;
      }
      departed.push([key, observed.leftAt]);
    }

    departed.sort(([, leftAtA], [, leftAtB]) => leftAtA - leftAtB);
    while (departed.length > MAX_DEPARTED_MEMBERSHIPS) {
      const oldest = departed.shift();
      if (oldest === undefined) break;
      this.observedMemberships.delete(oldest[0]);
    }
  }

  private handleTimelineEvent = (
    event: MatrixEvent,
    _room?: MatrixRoom,
    toStartOfTimeline?: boolean,
    removed?: boolean,
    data?: IRoomTimelineData,
  ): void => {
    if (
      removed === true ||
      toStartOfTimeline === true ||
      data?.liveEvent !== true
    ) {
      return;
    }

    const eventId = event.getId();
    if (!eventId) return;

    if (
      event.getType() === ElementCallTerminateEventType ||
      event.isEncrypted()
    ) {
      this.rememberLiveEvent(eventId);
      this.handleTerminationEvent(event);
    }
  };

  private handleDecryptedEvent = (event: MatrixEvent): void => {
    const eventId = event.getId();
    if (!eventId || !this.liveEventIds.has(eventId)) return;
    this.handleTerminationEvent(event);
  };

  /**
   * Handle incoming Matrix events, filtering for termination events.
   */
  private handleTerminationEvent = (event: MatrixEvent): void => {
    const room = this.rtcSession.room;
    const eventId = event.getId();

    // Decrypted events might come from a different room.
    if (event.getRoomId() !== room.roomId) return;

    // Skip any events that are still sending.
    if (event.isSending()) return;

    const sender = event.getSender();

    // Skip events without sender or ID, or events already admitted.
    if (!sender || !eventId) return;
    if (this.emittedEventIds.has(eventId)) return;

    const eventType = event.getType();
    if (eventType !== ElementCallTerminateEventType) {
      // An encrypted event has no usable type/content until it is decrypted.
      // Decryption re-enters this same handler and therefore cannot bypass
      // the live-event or participant checks below.
      if (event.isDecryptionFailure()) return;
      if (!event.isEncrypted()) {
        this.liveEventIds.delete(eventId);
        return;
      }
      if (event.isBeingDecrypted()) return;
      void room.client
        .decryptEventIfNeeded(event)
        .catch((error) =>
          logger.warn(`Failed to decrypt termination event ${eventId}`, error),
        );
      return;
    }

    if (event.isBeingDecrypted() || event.isDecryptionFailure()) return;

    // Ignore events sent by ourselves - we'll leave via our own hangup. Keep
    // the existing same-account semantics, including other devices.
    const localUserId = this.client.getUserId();
    if (sender === localUserId) {
      logger.debug(`Ignoring self-sent termination event from ${sender}`);
      this.liveEventIds.delete(eventId);
      return;
    }

    const termination = parseTerminationEvent(event, sender);
    if (!termination) {
      logger.warn(`Invalid termination event content from ${sender}`);
      this.liveEventIds.delete(eventId);
      return;
    }

    if (
      this.localJoinedAt !== undefined &&
      event.getTs() < this.localJoinedAt
    ) {
      this.liveEventIds.delete(eventId);
      return;
    }

    if (!this.isObservedParticipant(sender, event.getTs())) {
      logger.warn(
        `Ignoring termination event from an unobserved participant ${sender}`,
      );
      this.liveEventIds.delete(eventId);
      return;
    }

    logger.info(`Call terminated by ${termination.terminatedBy}`);

    // Mark only after every admission check succeeds. A pass which is still
    // decrypting must be allowed to re-enter this path.
    this.liveEventIds.delete(eventId);
    this.rememberEmittedEvent(eventId);
    this.terminationSubject$.next(termination);
  };

  private isObservedParticipant(
    sender: string,
    eventTimestamp: number,
  ): boolean {
    const now = Date.now();
    this.pruneDepartedMemberships(now);
    const memberships = [...this.observedMemberships.values()].filter(
      (membership) => membership.userId === sender,
    );
    const currentMemberships = memberships.filter(
      (membership) => membership.leftAt === undefined,
    );
    const candidates =
      currentMemberships.length > 0
        ? currentMemberships
        : memberships.filter(
            (membership) =>
              membership.leftAt !== undefined &&
              now - membership.leftAt <= DEPARTED_PARTICIPANT_GRACE_MS &&
              eventTimestamp <=
                membership.leftAt + DEPARTED_EVENT_CLOCK_SKEW_MS,
          );

    return candidates.some(
      (membership) =>
        !isPositiveFiniteNumber(membership.createdTs) ||
        eventTimestamp >= membership.createdTs,
    );
  }

  private rememberLiveEvent(eventId: string): void {
    this.liveEventIds.add(eventId);
    while (this.liveEventIds.size > MAX_PENDING_EVENT_IDS) {
      const oldestEventId = this.liveEventIds.keys().next().value;
      if (oldestEventId === undefined) break;
      this.liveEventIds.delete(oldestEventId);
    }
  }

  private rememberEmittedEvent(eventId: string): void {
    this.emittedEventIds.add(eventId);
    while (this.emittedEventIds.size > MAX_EMITTED_EVENT_IDS) {
      const oldestEventId = this.emittedEventIds.keys().next().value;
      if (oldestEventId === undefined) break;
      this.emittedEventIds.delete(oldestEventId);
    }
  }
}
