/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { expect, test, type Page } from "@playwright/test";

import { widgetTest } from "../fixtures/widget-user.ts";
import { HOST1, TestHelpers } from "./test-helpers.ts";

async function approveWidgetPermissions(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", {
    name: "Approve widget permissions",
  });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole("button", { name: "Approve", exact: true }).click();
}

async function toggleScreenSharing(page: Page): Promise<void> {
  const frame = page.locator('iframe[title="Element Call"]').contentFrame();
  // The call footer auto-hides after three seconds. Hovering the call root is
  // the user-visible way to reveal it before clicking a control.
  await frame.locator("body").hover();
  await frame.getByRole("switch", { name: /^(Share|Sharing) screen$/ }).click();
}

widgetTest.use({
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--auto-select-desktop-capture-source=Entire screen",
      "--mute-audio",
    ],
  },
});

widgetTest("Sharing screen in group call", async ({ addUser, browserName }) => {
  test.skip(
    browserName === "firefox",
    "The is test is not working on firefox CI environment. No mic/audio device inputs so cam/mic are disabled",
  );

  test.slow(); // We are registering multiple users here, give it more time

  const [alice, bob, carol] = await Promise.all([
    addUser("Alice", HOST1),
    addUser("Bob", HOST1),
    addUser("Carol", HOST1),
  ]);

  const roomName = "Meeting Room";
  await TestHelpers.createRoom(roomName, alice.page, [bob.mxId, carol.mxId]);

  for (const user of [bob, carol]) {
    // Accept the invite
    // This isn't super stable to get this as this super generic locator,
    // but it works for now.
    await TestHelpers.acceptRoomInvite(roomName, user.page);
  }

  await TestHelpers.startCallInCurrentRoom(alice.page, false);
  await approveWidgetPermissions(alice.page);
  await expect(alice.page.locator('iframe[title="Element Call"]')).toBeVisible({
    timeout: 30_000,
  });

  await TestHelpers.joinCallFromLobby(alice.page);

  for (const user of [bob, carol]) {
    await TestHelpers.joinCallInCurrentRoom(user.page);
    await approveWidgetPermissions(user.page);
  }

  for (const user of [alice, bob, carol]) {
    const frame = user.page
      .locator('iframe[title="Element Call"]')
      .contentFrame();

    // Expect 3 video tiles
    await expect(frame.locator("video")).toHaveCount(3, {
      timeout: 10000,
    });
  }

  // await alice.page.pause();

  await toggleScreenSharing(alice.page);

  // await alice.page.pause();

  for (const user of [alice, bob, carol]) {
    const frame = user.page
      .locator('iframe[title="Element Call"]')
      .contentFrame();

    // Three grid cameras plus the share and its paired carousel camera.
    await expect(frame.locator("video")).toHaveCount(5, {
      timeout: 5000,
    });

    await expect(
      frame.locator('video[data-lk-source="screen_share"]'),
    ).toHaveCount(1);
  }

  // Alice should be in grid mode as she is local sharing
  {
    const frame = alice.page
      .locator('iframe[title="Element Call"]')
      .contentFrame();
    await expect(frame.getByRole("radio", { name: "Grid" })).toBeChecked();
  }

  // A remote screen share keeps the share-driven spotlight layout, while the
  // spotlight tile also exposes the same participant's camera as its next
  // carousel candidate. Scope to aria-hidden spotlight items so the camera's
  // separate grid tile cannot satisfy these assertions.
  const carolFrame = carol.page
    .locator('iframe[title="Element Call"]')
    .contentFrame();
  const spotlightItems = carolFrame.locator("[data-id][aria-hidden]");
  await expect(spotlightItems).toHaveCount(2);
  const spotlightShare = spotlightItems.filter({
    has: carolFrame.locator('video[data-lk-source="screen_share"]'),
  });
  const spotlightCamera = spotlightItems.filter({
    has: carolFrame.locator('video[data-lk-source="camera"]'),
  });
  await expect(spotlightShare).toHaveAttribute("aria-hidden", "false");
  await expect(spotlightCamera).toHaveAttribute("aria-hidden", "true");
  await carolFrame.getByRole("button", { name: "Next" }).click();
  await expect(spotlightCamera).toHaveAttribute("aria-hidden", "false");

  // Stopping the share removes the share candidate and restores the normal
  // no-share participant layout.
  await toggleScreenSharing(alice.page);
  await expect(
    carolFrame.locator('video[data-lk-source="screen_share"]'),
  ).toHaveCount(0);
  // The no-share path may return to grid or spotlight-speaker layout, so
  // assert its stable semantics rather than requiring Alice's camera to stay
  // in the spotlight tile.
  await expect(
    carolFrame.locator('video[data-lk-source="camera"]'),
  ).toHaveCount(3);
  await expect(
    carolFrame.getByRole("button", { name: "Next" }),
  ).not.toBeVisible();

  // Re-enable Alice's share for the multi-share ordering checks below.
  await toggleScreenSharing(alice.page);

  // Others should have switched to spotlight
  for (const user of [bob, carol]) {
    const frame = user.page
      .locator('iframe[title="Element Call"]')
      .contentFrame();

    await expect(frame.getByRole("radio", { name: "Spotlight" })).toBeChecked();
  }
  // await alice.page.pause();
  // await bob.page.pause();

  // Let's start another screen share from bob
  await toggleScreenSharing(bob.page);

  {
    const frame = carol.page
      .locator('iframe[title="Element Call"]')
      .contentFrame();

    // Three grid cameras and two share/camera carousel pairs.
    await expect(frame.locator("video")).toHaveCount(7, {
      timeout: 5000,
    });

    await expect(
      frame.locator('video[data-lk-source="screen_share"]'),
    ).toHaveCount(2);

    // Each share is followed by its camera in the carousel.
    await expect(frame.getByTestId("screenshare-indicator")).toHaveCount(4);

    // Check the first indicator is visible
    await expect(
      frame.getByTestId("screenshare-indicator").first(),
    ).toHaveAttribute("data-visible", "true");

    // now click on next
    await expect(frame.getByRole("button", { name: "Next" })).toBeVisible();
    await frame.getByRole("button", { name: "Next" }).click();

    // Check the second indicator is visible
    await expect(
      frame.getByTestId("screenshare-indicator").nth(1),
    ).toHaveAttribute("data-visible", "true");
    // the first one should be grayed out
    await expect(
      frame.getByTestId("screenshare-indicator").first(),
    ).toHaveAttribute("data-visible", "false");

    // There should be a prev button now
    await expect(frame.getByRole("button", { name: "Back" })).toBeVisible();

    // await carol.page.pause();
  }
});
