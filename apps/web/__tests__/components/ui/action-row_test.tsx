import { screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import { ActionRow } from '../../../src/components/ui/action-row.tsx';
import { renderInApp } from '../../render.tsx';

test('action rows own the sourced responsive WinUI spacing boundary', () => {
  renderInApp(<ActionRow aria-label="Backup actions" role="group">
    <button type="button">Full backup</button>
    <button type="button">Safe export</button>
  </ActionRow>);

  const row = screen.getByRole('group', { name: 'Backup actions' });
  expect(row.className).toContain('flex');
  expect(row.className).toContain('flex-col');
  expect(row.className).toContain('flex-nowrap');
  expect(row.className).toContain('sm:flex-row');
  expect(row.className).not.toContain('flex-wrap');
  expect(row.className).not.toContain('items-center');
  expect(row.className).toContain('gap-[var(--spacingHorizontalS)]');
  expect(screen.getByRole('button', { name: 'Full backup' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Safe export' })).toBeTruthy();
});
