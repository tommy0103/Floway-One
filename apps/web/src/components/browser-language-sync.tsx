import { useEffect } from 'react';

import { setLanguage } from '../i18n';
import { selectedLanguage } from '../i18n/languages';

export function BrowserLanguageSync() {
  useEffect(() => {
    void setLanguage(selectedLanguage());
  }, []);

  return null;
}
