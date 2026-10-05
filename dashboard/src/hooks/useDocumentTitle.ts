import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Custom hook to set document title dynamically.
 * Automatically appends the product name, read from `common.appName` — the one place the name
 * lives — so the tab can never disagree with the rest of the interface.
 */
export function useDocumentTitle(title: string) {
  const { t } = useTranslation();
  const appName = t('common.appName');
  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${title} | ${appName}`;

    return () => {
      document.title = previousTitle;
    };
  }, [title, appName]);
}
