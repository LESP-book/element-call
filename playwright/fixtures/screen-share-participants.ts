/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  devices,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
  type TestInfo,
} from "@playwright/test";

import { SpaHelpers } from "../spa-helpers.ts";

export interface ScreenShareParticipants {
  desktopPage: Page;
  viewerPage: Page;
  inviteLink: string;
}

export type ViewerDevice = "Pixel 7" | "iPhone 13";

type ContextToClose = {
  name: "desktop" | "viewer";
  context: BrowserContext;
};

/**
 * Creates an isolated desktop sharer and mobile viewer for a remote screen-share
 * call. The browser process comes from the selected Playwright project; only
 * the two contexts receive device descriptors here.
 */
export async function withScreenShareParticipants<T>(
  browser: Browser,
  testInfo: TestInfo,
  viewerDevice: ViewerDevice,
  callback: (participants: ScreenShareParticipants) => Promise<T>,
): Promise<T> {
  const baseURL = getBaseURL(testInfo);
  let desktopContext: BrowserContext | undefined;
  let viewerContext: BrowserContext | undefined;
  let operationFailed = false;
  let primaryError: unknown;
  let result: T | undefined;

  try {
    desktopContext = await browser.newContext({
      ...devices["Desktop Chrome"],
      baseURL,
      ignoreHTTPSErrors: true,
      permissions: [
        "clipboard-write",
        "clipboard-read",
        "microphone",
        "camera",
      ],
      reducedMotion: "reduce",
    });
    const desktopPage = await desktopContext.newPage();
    await desktopPage.goto("/");

    await SpaHelpers.createCall(
      desktopPage,
      "Desktop sharer",
      "Mobile screen share layout",
      true,
    );

    await expect(
      desktopPage.locator("[data-element-call-root]"),
    ).toHaveAttribute("data-platform", "desktop");

    const inviteLink = await SpaHelpers.getCallInviteLink(desktopPage);
    await expect(desktopPage.getByTestId("modal_close")).not.toBeVisible();

    const viewerDescriptor = devices[viewerDevice];
    viewerContext = await browser.newContext({
      ...viewerDescriptor,
      baseURL,
      ignoreHTTPSErrors: true,
      permissions: [
        "clipboard-write",
        "clipboard-read",
        "microphone",
        "camera",
      ],
      reducedMotion: "reduce",
    });
    const viewerPage = await viewerContext.newPage();
    await viewerPage.goto(inviteLink);
    await viewerPage.getByTestId("joincall_displayName").fill("Mobile viewer");
    await expect(viewerPage.getByTestId("joincall_joincall")).toBeVisible();
    await viewerPage.getByTestId("joincall_joincall").click();
    await viewerPage.getByTestId("lobby_joinCall").click();

    const desktopRoot = desktopPage.locator("[data-element-call-root]");
    await desktopRoot.hover();
    const shareButton = desktopPage.getByTestId("incall_screenshare");
    await expect(shareButton).toBeVisible();
    await shareButton.click();
    await expect(shareButton).toHaveAttribute("aria-checked", "true");

    await expect(
      viewerPage.locator('video[data-lk-source="screen_share"]'),
    ).toBeVisible({ timeout: 30_000 });

    result = await callback({ desktopPage, viewerPage, inviteLink });
  } catch (error) {
    operationFailed = true;
    primaryError = error;
  }

  const cleanupError = await closeContexts(
    [
      viewerContext === undefined
        ? null
        : { name: "viewer" as const, context: viewerContext },
      desktopContext === undefined
        ? null
        : { name: "desktop" as const, context: desktopContext },
    ].filter((context): context is ContextToClose => context !== null),
  );

  if (cleanupError !== undefined) {
    if (operationFailed) {
      preserveCleanupFailure(primaryError, cleanupError);
    } else {
      throw cleanupError;
    }
  }

  if (operationFailed) {
    if (primaryError instanceof Error) throw primaryError;
    throw new Error("Screen-share setup failed", { cause: primaryError });
  }

  return result as T;
}

function getBaseURL(testInfo: TestInfo): string {
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== "string") {
    throw new Error("The mobile Playwright project must provide a baseURL");
  }
  return baseURL;
}

async function closeContexts(
  contexts: ContextToClose[],
): Promise<Error | undefined> {
  const results = await Promise.allSettled(
    contexts.map(async ({ name, context }) => {
      try {
        await context.close();
      } catch (error) {
        throw new Error(`${name} context cleanup failed`, { cause: error });
      }
    }),
  );
  const errors = results
    .filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )
    .map((result) => result.reason);

  return errors.length === 0
    ? undefined
    : new AggregateError(errors, "Screen-share context cleanup failed");
}

function preserveCleanupFailure(
  primaryError: unknown,
  cleanupError: Error,
): void {
  if (primaryError instanceof Error) {
    primaryError.message += `\n${cleanupError.message}`;
    const errorWithCause = primaryError as Error & { cause?: unknown };
    errorWithCause.cause =
      errorWithCause.cause === undefined
        ? cleanupError
        : new AggregateError(
            [errorWithCause.cause, cleanupError],
            "Primary error and cleanup error",
          );
    return;
  }

  throw new AggregateError(
    [primaryError, cleanupError],
    "Primary operation and context cleanup failed",
  );
}
