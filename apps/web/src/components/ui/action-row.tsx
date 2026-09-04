import type { ComponentPropsWithoutRef } from 'react';

import { fluentComponents } from '../../fluent';

const { mergeClasses } = fluentComponents;

// WinUI's settings action group is a non-wrapping horizontal StackPanel with
// Spacing="8". Floway keeps that spacing through Fluent's small horizontal
// token, stacks actions vertically below the established `sm` breakpoint, and
// restores the sourced horizontal orientation from `sm` upward.
// https://github.com/microsoft/WinUI-Gallery/blob/f4dc3eb367f4bcecac1793829d9a221e924e5bfb/WinUIGallery/Pages/SettingsPage.xaml#L88-L100
const ACTION_ROW_CLASS = 'flex min-w-0 flex-col flex-nowrap gap-[var(--spacingHorizontalS)] [&>*]:min-w-0 sm:flex-row sm:items-center';

export function ActionRow({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return <div {...props} className={mergeClasses(ACTION_ROW_CLASS, className)} />;
}
