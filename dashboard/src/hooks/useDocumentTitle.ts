import { useEffect } from 'react';

/**
 * Custom hook to set document title dynamically.
 * Automatically appends the product-name suffix.
 */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${title} | Rangila`;

    return () => {
      document.title = previousTitle;
    };
  }, [title]);
}
