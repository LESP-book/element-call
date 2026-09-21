/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@vector-im/compound-web";

import { HeaderToggleButton } from "./HeaderToggleButton";

describe("HeaderToggleButton", () => {
  test.each([
    [true, "Hide header", "true"],
    [false, "Show header", "false"],
  ])("exposes its pinned state (%s)", (headerPinned, label, pressed) => {
    render(
      <TooltipProvider>
        <HeaderToggleButton headerPinned={headerPinned} onToggle={vi.fn()} />
      </TooltipProvider>,
    );

    expect(screen.getByRole("button", { name: label })).toHaveAttribute(
      "aria-pressed",
      pressed,
    );
  });
});
