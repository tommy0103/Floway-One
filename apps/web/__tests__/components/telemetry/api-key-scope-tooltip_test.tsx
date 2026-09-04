import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ApiKeyScopeTooltip } from '../../../src/components/telemetry/api-key-scope-tooltip';
import { renderInApp } from '../../render';

describe('API key telemetry scope tooltip', () => {
  it.each([
    {
      label: 'About API key telemetry scope',
      personalProfile: false,
      text: 'API key grouping and filters include only keys owned by your account. Choosing By API Key sets User to Only me; choosing another user clears API key filters and returns to By Model.',
    },
    {
      label: 'About local-owner API key telemetry scope',
      personalProfile: true,
      text: 'API key grouping and filters include keys owned by this local owner. Choosing By API Key keeps telemetry scoped to the local owner.',
    },
  ])('renders $label from the deployment profile', async ({ label, personalProfile, text }) => {
    renderInApp(<ApiKeyScopeTooltip personalProfile={personalProfile} />);

    fireEvent.pointerEnter(screen.getByRole('button', { name: label }));
    const copy = (await screen.findByRole('tooltip')).textContent ?? '';
    expect(copy).toBe(text);
    if (personalProfile) expect(copy).not.toMatch(/\bUser\b|Only me|another user/);
  });
});
