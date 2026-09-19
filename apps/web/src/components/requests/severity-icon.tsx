import { CheckmarkCircleRegular, DismissCircleRegular } from '@fluentui/react-icons';

import type { RequestSeverity } from './format';
import { fluentComponents } from '../../fluent';

const { makeStyles } = fluentComponents;

const useStyles = makeStyles({
  // WinUI's SystemFillColorCritical, Success and Caution, each tuned per theme
  // dictionary, so none of the three is restated for dark.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L280-L282
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L76-L78
  error: { color: 'var(--winui-system-fill-critical)' },
  success: { color: 'var(--winui-system-fill-success)' },
  warning: { color: 'var(--winui-system-fill-caution)' },
});

// The severity fills, for the parts of a request reading that are not the
// glyph (the request list also paints its error text in the critical fill).
export const useRequestSeverityClasses = (): Record<RequestSeverity, string> => useStyles();

// The one reading of a request's outcome: a failed record and a warned one
// both take the dismiss glyph, and the colour -- never the glyph -- separates
// warning from error. Every surface that summarizes a dump record (the request
// list's rows, the overview's recent-request panel) renders this, so the two
// cannot drift.
export function RequestSeverityIcon({ severity }: { severity: RequestSeverity }) {
  const classes = useRequestSeverityClasses();
  const StatusIcon = severity === 'success' ? CheckmarkCircleRegular : DismissCircleRegular;
  return <StatusIcon aria-hidden="true" className={`block flex-none ${classes[severity]}`} fontSize={22} />;
}
