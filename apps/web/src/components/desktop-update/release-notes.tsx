import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { DialogShell } from '../ui/dialog-shell';
import { BlockMarkdown } from '../ui/markdown';

const { Button, DialogActions, DialogTitle } = fluentComponents;

export function ReleaseNotesDialog({ body, onExited, onOpenChange, open, version }: {
  body: string | null;
  onExited: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  version: string;
}) {
  const { t } = useTranslation();
  return <DialogShell
    actions={<DialogActions><Button onClick={() => onOpenChange(false)}>{t('dashboard.settings.desktop.update.close')}</Button></DialogActions>}
    onExited={onExited}
    onOpenChange={(_, data) => onOpenChange(data.open)}
    open={open}
    title={<DialogTitle>{t('dashboard.settings.desktop.update.notesTitle', { version })}</DialogTitle>}
    width="editor"
  >
    {body?.trim() ? <BlockMarkdown>{body}</BlockMarkdown> : <p>{t('dashboard.settings.desktop.update.noNotes')}</p>}
  </DialogShell>;
}
