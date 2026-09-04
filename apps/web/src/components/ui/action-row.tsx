import type { ComponentPropsWithoutRef } from 'react';

import { fluentComponents } from '../../fluent';

const { mergeClasses } = fluentComponents;

// WinUI's settings action group is a horizontal StackPanel with Spacing="8".
// Floway keeps that step through Fluent's small horizontal token and allows
// wrapping so localized actions remain reachable on narrow browser viewports.
// https://github.com/microsoft/WinUI-Gallery/blob/f4dc3eb367f4bcecac1793829d9a221e924e5bfb/WinUIGallery/Pages/SettingsPage.xaml#L88-L100
const ACTION_ROW_CLASS = 'flex flex-wrap gap-[var(--spacingHorizontalS)]';

export function ActionRow({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return <div {...props} className={mergeClasses(ACTION_ROW_CLASS, className)} />;
}
