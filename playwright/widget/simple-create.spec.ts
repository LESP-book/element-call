/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { expect, type Page, test } from "@playwright/test";

import { widgetTest } from "../fixtures/widget-user.ts";
import { TestHelpers } from "./test-helpers.ts";

async function approveWidgetPermissions(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", {
    name: "Approve widget permissions",
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Approve", exact: true }).click();
}

// Skip test, including Fixtures
widgetTest.skip(
  ({ browserName }) => browserName === "firefox",
  "This test is not working on firefox, after hangup brooks is locked in a strange state with a blank widget",
);

widgetTest("Start a new call as widget", async ({ asWidget, browserName }) => {
  test.slow();

  const { brooks, whistler } = asWidget;

  // Keep the first media request pending so this test can prove that a direct
  // join does not start LiveKit before browser permission has settled.
  await whistler.page.addInitScript(() => {
    const permissionGate = Promise.withResolvers<void>();
    const mediaPermissionState = {
      requests: 0,
      completed: 0,
      error: null as string | null,
    };
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      mediaPermissionState.requests += 1;
      await permissionGate.promise;
      try {
        const stream = await getUserMedia(constraints);
        mediaPermissionState.completed += 1;
        return stream;
      } catch (error) {
        mediaPermissionState.error = String(error);
        throw error;
      }
    };
    Object.defineProperty(window, "releaseMediaPermission", {
      value: permissionGate.resolve,
    });
    Object.defineProperty(window, "mediaPermissionState", {
      value: mediaPermissionState,
    });
  });

  await TestHelpers.startCallInCurrentRoom(brooks.page, false);
  await approveWidgetPermissions(brooks.page);

  await expect(
    brooks.page
      .locator('iframe[title="Element Call"]')
      .contentFrame()
      .getByTestId("lobby_joinCall"),
  ).toBeVisible();

  await brooks.page
    .locator('iframe[title="Element Call"]')
    .contentFrame()
    .getByTestId("lobby_joinCall")
    .click();

  // Check the join indicator on the room list
  await expect(
    brooks.page
      .locator('iframe[title="Element Call"]')
      .contentFrame()
      .getByRole("button", { name: "End call" }),
  ).toBeVisible();

  // Join from the other side
  await TestHelpers.joinCallInCurrentRoom(whistler.page);
  await approveWidgetPermissions(whistler.page);

  const whistlerCall = whistler.page
    .locator('iframe[title="Element Call"]')
    .contentFrame();
  const whistlerEndCall = whistlerCall.getByRole("button", {
    name: "End call",
  });
  await expect(whistlerCall.locator("body")).toBeVisible();
  await expect
    .poll(
      async () =>
        await whistlerCall.locator("body").evaluate(() => {
          return (
            window as typeof window & {
              mediaPermissionState: { requests: number };
            }
          ).mediaPermissionState.requests;
        }),
    )
    .toBeGreaterThan(0);
  await expect(whistlerEndCall).toBeHidden();

  await whistlerCall.locator("body").evaluate(() => {
    (
      window as typeof window & { releaseMediaPermission: () => void }
    ).releaseMediaPermission();
  });
  await expect
    .poll(
      async () =>
        await whistlerCall.locator("body").evaluate(() => {
          return (
            window as typeof window & {
              mediaPermissionState: {
                completed: number;
                error: string | null;
              };
            }
          ).mediaPermissionState;
        }),
    )
    .toMatchObject({ completed: 1, error: null });
  await expect(whistlerEndCall).toBeVisible({
    timeout: 15_000,
  });

  // Currently disabled due to recent Element Web is bypassing Lobby
  // await expect(
  //   whistler.page
  //     .locator('iframe[title="Element Call"]')
  //     .contentFrame()
  //     .getByTestId("lobby_joinCall"),
  // ).toBeVisible();
  //
  // await whistler.page
  //   .locator('iframe[title="Element Call"]')
  //   .contentFrame()
  //   .getByTestId("lobby_joinCall")
  //   .click();

  // Currrenty disabled due to recent Element Web not indicating the number of participants
  // await expect(
  //   whistler.page.locator("div").filter({ hasText: /^Joined • 2$/ }),
  // ).toBeVisible();

  // await expect(
  //   brooks.page.locator("div").filter({ hasText: /^Joined • 2$/ }),
  // ).toBeVisible();

  // Whistler leaves
  await whistler.page.waitForTimeout(1000);
  await whistlerEndCall.click();
  await whistlerCall.getByRole("menuitem", { name: "Leave call" }).click();

  // Brooks leaves
  const brooksCall = brooks.page
    .locator('iframe[title="Element Call"]')
    .contentFrame();
  await brooksCall
    .locator("[data-layout]")
    .dispatchEvent("pointermove", { pointerType: "mouse" });
  await brooksCall
    .getByRole("button", { name: "End call" })
    .click({ timeout: 15000 });
  await brooksCall.getByRole("menuitem", { name: "Leave call" }).click();

  await expect(whistler.page.locator(".mx_BasicMessageComposer")).toBeVisible({
    timeout: 10000,
  });
  await expect(brooks.page.locator(".mx_BasicMessageComposer")).toBeVisible({
    timeout: 10000,
  });
});
