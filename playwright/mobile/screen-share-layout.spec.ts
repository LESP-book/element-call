/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { writeFile } from "node:fs/promises";

import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";

import {
  type ViewerDevice,
  withScreenShareParticipants,
} from "../fixtures/screen-share-participants.ts";

type ScreenShareCase = {
  name: string;
  slug: string;
  device: ViewerDevice;
  expectedPlatform: "android" | "ios";
};

const screenShareCases: ScreenShareCase[] = [
  {
    name: "Android Pixel 7",
    slug: "android-pixel-7",
    device: "Pixel 7",
    expectedPlatform: "android",
  },
  {
    name: "iOS iPhone 13",
    slug: "ios-iphone-13",
    device: "iPhone 13",
    expectedPlatform: "ios",
  },
];

type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
};

type FooterState = {
  box: Box | null;
  position: string;
  display: string;
  toolbarOpacity: string;
  visible: boolean;
};

type GeometryState = {
  state: "footer-visible" | "footer-hidden" | "footer-visible-again";
  platform: string | null;
  layout: string | null;
  root: Box;
  header: Box;
  screenShare: Box;
  participantTiles: Box[];
  firstParticipant: Box;
  lastVisibleParticipant: Box | null;
  footer: FooterState;
  shareParticipantOverlapPixels: number;
  footerParticipantOverlapPixels: number;
};

for (const screenShareCase of screenShareCases) {
  test(`mobile screen-share layout: ${screenShareCase.name}`, async ({
    browser,
  }, testInfo) => {
    await withScreenShareParticipants(
      browser,
      testInfo,
      screenShareCase.device,
      async ({ desktopPage, viewerPage }) => {
        await expect(
          desktopPage.locator("[data-element-call-root]"),
        ).toHaveAttribute("data-platform", "desktop");
        await expect(
          viewerPage.locator("[data-element-call-root]"),
        ).toHaveAttribute("data-platform", screenShareCase.expectedPlatform);

        await assertLayoutReady(viewerPage);

        const measurements: GeometryState[] = [];
        const callView = viewerPage.locator(
          '[data-layout="spotlight-portrait"]',
        );
        const footer = viewerPage.getByTestId("footer-container");

        await setFooterVisibility(viewerPage, callView, footer, true);
        measurements.push(await measureGeometry(viewerPage, "footer-visible"));

        await setFooterVisibility(viewerPage, callView, footer, false);
        measurements.push(await measureGeometry(viewerPage, "footer-hidden"));

        await setFooterVisibility(viewerPage, callView, footer, true);
        measurements.push(
          await measureGeometry(viewerPage, "footer-visible-again"),
        );

        await attachDiagnostics(testInfo, viewerPage, screenShareCase.slug, {
          platform: screenShareCase.expectedPlatform,
          measurements,
        });

        assertGeometry(measurements, screenShareCase.name);
      },
    );
  });
}

async function assertLayoutReady(page: Page): Promise<void> {
  const callView = page.locator('[data-layout="spotlight-portrait"]');
  await expect(callView).toBeVisible({ timeout: 30_000 });

  const { fixedGrid, scrollingGrid } = getLayoutLayers(callView);
  await expect(fixedGrid).toHaveCount(1);
  await expect(scrollingGrid).toHaveCount(1);
  await expect(
    fixedGrid.locator('video[data-lk-source="screen_share"]'),
  ).toBeVisible({ timeout: 30_000 });
  const participantTiles = scrollingGrid.locator('[data-testid="videoTile"]');
  await expect(participantTiles).toHaveCount(2);
  for (const index of [0, 1]) {
    const participantTile = participantTiles.nth(index);
    await expect(participantTile).toBeVisible({ timeout: 30_000 });
    await waitForStableBox(participantTile, `participant tile ${index + 1}`);
  }
  await expect(callView.locator("header").first()).toBeVisible();
}

function getLayoutLayers(callView: Locator): {
  fixedGrid: Locator;
  scrollingGrid: Locator;
} {
  const fixedGrid = callView.locator(':scope > div:has([data-id="spotlight"])');
  const scrollingGrid = callView.locator(
    ':scope > div:has([data-testid="videoTile"]):not(:has([data-id="spotlight"]))',
  );

  return { fixedGrid, scrollingGrid };
}

async function setFooterVisibility(
  page: Page,
  callView: Locator,
  footer: Locator,
  visible: boolean,
): Promise<void> {
  if ((await footerIsVisible(footer)) !== visible) {
    const callViewBox = await callView.boundingBox();
    if (callViewBox === null) {
      throw new Error("Could not tap the call view background");
    }

    // Page.touchscreen.tap emits the real mobile pointer path with
    // pointerType="touch". The left edge is outside all media controls.
    await page.touchscreen.tap(
      callViewBox.x + Math.min(4, callViewBox.width / 2),
      callViewBox.y + callViewBox.height / 2,
    );
  }
  await waitForFooterVisibility(footer, visible);
}

async function footerIsVisible(footer: Locator): Promise<boolean> {
  return footer.evaluate((element) => {
    const toolbar = element.firstElementChild;
    if (!(toolbar instanceof HTMLElement)) return false;
    const style = getComputedStyle(toolbar);
    return (
      Number.parseFloat(style.opacity) > 0 && style.pointerEvents !== "none"
    );
  });
}

async function waitForFooterVisibility(
  footer: Locator,
  visible: boolean,
): Promise<void> {
  await expect
    .poll(async () => await footerIsVisible(footer), { timeout: 5_000 })
    .toBe(visible);
}

async function measureGeometry(
  page: Page,
  state: GeometryState["state"],
): Promise<GeometryState> {
  const rootLocator = page.locator("[data-element-call-root]");
  const callView = page.locator('[data-layout="spotlight-portrait"]');
  const headerLocator = callView.locator("header").first();
  const footerLocator = page.getByTestId("footer-container");
  const { fixedGrid, scrollingGrid } = getLayoutLayers(callView);
  const screenShareVideo = fixedGrid.locator(
    'video[data-lk-source="screen_share"]',
  );
  const screenShareTile = screenShareVideo.locator(
    'xpath=ancestor::*[@data-testid="videoTile"][1]',
  );
  const participantTilesLocator = scrollingGrid.locator(
    '[data-testid="videoTile"]',
  );

  await waitForStableBox(screenShareTile, "screen-share tile");
  for (const index of [0, 1]) {
    await waitForStableBox(
      participantTilesLocator.nth(index),
      `participant tile ${index + 1}`,
    );
  }

  const root = await requiredBox(rootLocator, "call root");
  const header = await requiredBox(headerLocator, "header");
  const screenShare = await requiredBox(screenShareTile, "screen-share tile");
  const participantTiles: Box[] = [];
  for (
    let index = 0;
    index < (await participantTilesLocator.count());
    index++
  ) {
    const participant = await participantTilesLocator.nth(index).boundingBox();
    if (participant !== null) participantTiles.push(toBox(participant));
  }

  if (participantTiles.length === 0) {
    throw new Error("No ordinary participant tile could be measured");
  }

  const orderedParticipants = [...participantTiles].sort(
    (a, b) => a.y - b.y || a.x - b.x,
  );
  const firstParticipant = orderedParticipants[0];
  const lastVisibleParticipant = participantTiles
    .filter((participant) => participant.y < root.bottom)
    .filter((participant) => participant.bottom > root.y)
    .sort((a, b) => b.bottom - a.bottom)[0];
  const footer = await measureFooter(footerLocator);

  return {
    state,
    platform: await rootLocator.getAttribute("data-platform"),
    layout: await callView.getAttribute("data-layout"),
    root,
    header,
    screenShare,
    participantTiles,
    firstParticipant,
    lastVisibleParticipant: lastVisibleParticipant ?? null,
    footer,
    shareParticipantOverlapPixels: verticalOverlap(
      screenShare,
      firstParticipant,
    ),
    footerParticipantOverlapPixels:
      footer.visible && footer.box !== null && lastVisibleParticipant !== null
        ? verticalOverlap(lastVisibleParticipant, footer.box)
        : 0,
  };
}

async function measureFooter(footer: Locator): Promise<FooterState> {
  const box = await footer.boundingBox();
  const style = await footer.evaluate((element) => {
    const toolbar = element.firstElementChild;
    const footerStyle = getComputedStyle(element);
    const toolbarStyle =
      toolbar instanceof HTMLElement ? getComputedStyle(toolbar) : null;
    return {
      position: footerStyle.position,
      display: footerStyle.display,
      toolbarOpacity: toolbarStyle?.opacity ?? "unknown",
      visible:
        toolbarStyle !== null &&
        Number.parseFloat(toolbarStyle.opacity) > 0 &&
        toolbarStyle.pointerEvents !== "none",
    };
  });

  return {
    box: box === null ? null : toBox(box),
    ...style,
  };
}

async function waitForStableBox(
  locator: Locator,
  description: string,
): Promise<void> {
  let previous: { x: number; y: number; width: number; height: number } | null =
    null;
  await expect
    .poll(
      async () => {
        const box = await locator.boundingBox();
        if (box === null) {
          previous = null;
          return false;
        }
        const stable =
          previous !== null &&
          Math.max(
            Math.abs(box.x - previous.x),
            Math.abs(box.y - previous.y),
            Math.abs(box.width - previous.width),
            Math.abs(box.height - previous.height),
          ) <= 1;
        previous = box;
        return stable;
      },
      { timeout: 10_000, message: `Waiting for stable ${description} bounds` },
    )
    .toBe(true);
}

async function requiredBox(
  locator: Locator,
  description: string,
): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`Could not measure ${description}`);
  return toBox(box);
}

function toBox(box: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Box {
  return {
    ...box,
    right: box.x + box.width,
    bottom: box.y + box.height,
  };
}

function verticalOverlap(first: Box, second: Box): number {
  return Math.max(
    0,
    Math.min(first.bottom, second.bottom) - Math.max(first.y, second.y),
  );
}

async function attachDiagnostics(
  testInfo: TestInfo,
  page: Page,
  slug: string,
  diagnostics: {
    platform: string;
    measurements: GeometryState[];
  },
): Promise<void> {
  const geometryPath = testInfo.outputPath(`${slug}-geometry.json`);
  await writeFile(geometryPath, JSON.stringify(diagnostics, null, 2));
  await testInfo.attach(`${slug}-geometry.json`, { path: geometryPath });

  const screenshotPath = testInfo.outputPath(`${slug}-layout.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach(`${slug}-layout.png`, { path: screenshotPath });
}

function assertGeometry(measurements: GeometryState[], caseName: string): void {
  for (const measurement of measurements) {
    const diagnostic = `${caseName} ${JSON.stringify(measurement, null, 2)}`;

    expect(
      measurement.shareParticipantOverlapPixels,
      `${diagnostic}\nshare/participant overlap: ${measurement.shareParticipantOverlapPixels}px`,
    ).toBeLessThanOrEqual(1);
    expect(
      measurement.screenShare.bottom,
      `${diagnostic}\nscreen share bottom is above the first participant`,
    ).toBeLessThanOrEqual(measurement.firstParticipant.y + 1);
    expect(
      measurement.screenShare.x,
      `${diagnostic}\nscreen share exceeds the left root boundary`,
    ).toBeGreaterThanOrEqual(measurement.root.x - 1);
    expect(
      measurement.screenShare.right,
      `${diagnostic}\nscreen share exceeds the right root boundary`,
    ).toBeLessThanOrEqual(measurement.root.right + 1);
    expect(
      Math.abs(measurement.screenShare.y - measurement.header.bottom),
      `${diagnostic}\nscreen share top is not aligned with the header bottom`,
    ).toBeLessThanOrEqual(1);

    if (
      measurement.footer.visible &&
      measurement.lastVisibleParticipant !== null &&
      measurement.footer.box !== null
    ) {
      expect(
        measurement.footerParticipantOverlapPixels,
        `${diagnostic}\nfooter/participant overlap: ${measurement.footerParticipantOverlapPixels}px`,
      ).toBeLessThanOrEqual(1);
    }
  }
}
