'use client';

import { useAuiState } from '@assistant-ui/react';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

/**
 * Creates an object URL for a local file, and revokes it when the file changes or the component unmounts.
 *
 * @param file The file, or undefined when there is none.
 * @returns The object URL, or undefined while no URL exists for the current file.
 */
const useFileSrc = (file: File | undefined) => {
  const [entry, setEntry] = useState<{ file: File; url: string } | undefined>(undefined);

  useEffect(() => {
    if (!file) {
      setEntry(undefined);
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setEntry({ file, url: objectUrl });

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  return entry !== undefined && entry.file === file ? entry.url : undefined;
};

/**
 * Returns the image source of the attachment in the current assistant-ui attachment scope.
 *
 * A local file gets an object URL. A sent attachment uses the URL of its image content.
 *
 * @returns The image URL, or undefined when the attachment is not an image.
 */
export const useAttachmentSrc = () => {
  const { file, src } = useAuiState(
    useShallow((s): { file?: File; src?: string } => {
      if (s.attachment.type !== 'image') return {};
      if (s.attachment.file) return { file: s.attachment.file };
      const src = s.attachment.content?.filter((c) => c.type === 'image')[0]?.image;
      if (!src) return {};
      return { src };
    }),
  );

  return useFileSrc(file) ?? src;
};
