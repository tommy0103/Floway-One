import { screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import { ActionRow } from '../../../src/components/ui/action-row.tsx';
import { renderInApp } from '../../render.tsx';

test('action rows own the sourced responsive WinUI spacing boundary', () => {
  renderInApp(<ActionRow aria-label="Backup actions" role="group" />);

  const row = screen.getByRole('group', { name: 'Backup actions' });
  expect(row.className).toContain('flex');
  expect(row.className).toContain('flex-wrap');
  expect(row.className).toContain('gap-[var(--spacingHorizontalS)]');
});
