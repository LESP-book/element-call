/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type FC } from "react";
import { IconButton, Tooltip } from "@vector-im/compound-web";
import { useTranslation } from "react-i18next";
import {
  VisibilityOnIcon,
  VisibilityOffIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";

import styles from "./HeaderToggleButton.module.css";

interface HeaderToggleButtonProps {
  headerPinned: boolean;
  onToggle: () => void;
}

export const HeaderToggleButton: FC<HeaderToggleButtonProps> = ({
  headerPinned,
  onToggle,
}) => {
  const { t } = useTranslation();

  const label = headerPinned
    ? t("header_toggle.hide")
    : t("header_toggle.show");

  return (
    <div className={styles.container}>
      <Tooltip label={label}>
        <IconButton
          aria-label={label}
          onClick={onToggle}
          className={styles.button}
        >
          {headerPinned ? <VisibilityOffIcon /> : <VisibilityOnIcon />}
        </IconButton>
      </Tooltip>
    </div>
  );
};
