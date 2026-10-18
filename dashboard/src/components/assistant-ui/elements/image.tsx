"use client";

import {
  memo,
  useState,
  useEffect,
  useCallback,
  useRef,
  type PropsWithChildren,
} from "react";
import { createPortal } from "react-dom";
import { cva, type VariantProps } from "class-variance-authority";
import {
  CopyIcon,
  DownloadIcon,
  ImageIcon,
  ImageOffIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  XIcon,
} from "lucide-react";
import type {
  ImageMessagePart,
  ImageMessagePartComponent,
} from "@assistant-ui/react";
import { cn } from "@/lib/utils";
import { useHistoryOverlay } from "@/hooks/use-history-overlay";
import { Spinner } from "@/components/Spinner";

/**
 * Gives the file extension for an image MIME type.
 *
 * @param mimeType The MIME type, if known.
 * @returns The extension without a dot. An unknown type gives "png".
 */
const extensionForMimeType = (mimeType?: string): string => {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/svg+xml":
      return "svg";
    default:
      return "png";
  }
};

/**
 * Converts a data URI to a blob. Base64 data is decoded. Other data is
 * percent-decoded as text.
 *
 * @param dataUri The data URI.
 * @returns The blob, with the MIME type of the data URI or "application/octet-stream".
 */
const dataUriToBlob = (dataUri: string): Blob => {
  const commaIndex = dataUri.indexOf(",");
  const meta = commaIndex >= 0 ? dataUri.slice(0, commaIndex) : dataUri;
  const data = commaIndex >= 0 ? dataUri.slice(commaIndex + 1) : "";
  const mime =
    meta.match(/data:([^;]+)/i)?.[1]?.toLowerCase() ??
    "application/octet-stream";
  if (!/;base64/i.test(meta)) {
    const text = data.replace(/(?:%[0-9A-Fa-f]{2})+/g, (seq) => {
      try {
        return decodeURIComponent(seq);
      } catch {
        return seq;
      }
    });
    return new Blob([text], { type: mime });
  }
  const bytes = atob(data);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
};

/**
 * Reads the MIME type from a data URI.
 *
 * @param image The image source.
 * @returns The MIME type in lower case, or undefined when the source is not a data URI.
 */
const mimeFromImage = (image: string): string | undefined =>
  image.match(/^data:([^;,]+)/i)?.[1]?.toLowerCase();

/**
 * Downloads an image through a temporary link. A data URI goes through an
 * object URL, which is revoked after 40 seconds.
 *
 * @param part The image part, with its source and optional file name.
 */
const downloadImagePart = (
  part: Pick<ImageMessagePart, "image" | "filename">,
): void => {
  if (typeof document === "undefined") return;
  const ext = extensionForMimeType(mimeFromImage(part.image));
  const filename = part.filename ?? `image.${ext}`;
  const isDataUri = /^data:/i.test(part.image);
  const objectUrl = isDataUri
    ? URL.createObjectURL(dataUriToBlob(part.image))
    : null;
  const href = objectUrl ?? part.image;
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 40_000);
};

/**
 * Copies an image to the clipboard. A source that is not a data URI is fetched first.
 *
 * @param part The image part, with its source.
 * @throws Error when the clipboard API is not available.
 */
const copyImagePart = async (
  part: Pick<ImageMessagePart, "image">,
): Promise<void> => {
  if (
    typeof navigator === "undefined" ||
    !navigator.clipboard ||
    typeof ClipboardItem === "undefined"
  ) {
    throw new Error("Clipboard API is not available in this environment.");
  }
  const blob = /^data:/i.test(part.image)
    ? dataUriToBlob(part.image)
    : await fetch(part.image).then((r) => r.blob());
  const mime = mimeFromImage(part.image) ?? blob.type ?? "image/png";
  await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })]);
};

/** The class names of an image frame for each variant and size. */
const imageVariants = cva(
  "aui-image-root relative overflow-hidden rounded-lg",
  {
    variants: {
      variant: {
        outline: "border-border border",
        ghost: "",
        muted: "bg-muted/50",
      },
      size: {
        sm: "max-w-64",
        default: "max-w-96",
        lg: "max-w-[512px]",
        full: "w-full",
      },
    },
    defaultVariants: {
      variant: "outline",
      size: "default",
    },
  },
);

/** The props of {@link ImageRoot}: any div prop and the variant props. */
export type ImageRootProps = React.ComponentProps<"div"> &
  VariantProps<typeof imageVariants>;

/**
 * The frame of an image part.
 *
 * @param props The variant, the size, the classes, the content and the other div props.
 */
function ImageRoot({
  className,
  variant,
  size,
  children,
  ...props
}: ImageRootProps) {
  return (
    <div
      data-slot="image-root"
      data-variant={variant}
      data-size={size}
      className={cn(imageVariants({ variant, size, className }))}
      {...props}
    >
      {children}
    </div>
  );
}

/** The props of {@link ImagePreview}: any img prop but children, and the classes of the container. */
type ImagePreviewProps = Omit<React.ComponentProps<"img">, "children"> & {
  /** Extra classes for the container around the image. */
  containerClassName?: string;
};

/**
 * An image with a placeholder while it loads and an icon when it fails.
 *
 * @param props The source, the alt text, the classes, the load handlers and the other img props.
 */
function ImagePreview({
  className,
  containerClassName,
  onLoad,
  onError,
  alt = "Image content",
  src,
  ...props
}: ImagePreviewProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | undefined>(undefined);
  const [errorSrc, setErrorSrc] = useState<string | undefined>(undefined);

  const loaded = loadedSrc === src;
  const error = errorSrc === src;

  useEffect(() => {
    if (
      typeof src === "string" &&
      imgRef.current?.complete &&
      imgRef.current.naturalWidth > 0
    ) {
      setLoadedSrc(src);
    }
  }, [src]);

  return (
    <div
      data-slot="image-preview"
      className={cn("relative min-h-32", containerClassName)}
    >
      {!loaded && !error && (
        <div
          data-slot="image-preview-loading"
          className="bg-muted/50 absolute inset-0 flex items-center justify-center"
        >
          <ImageIcon className="text-muted-foreground size-8 animate-pulse" />
        </div>
      )}
      {error ? (
        <div
          data-slot="image-preview-error"
          className="bg-muted/50 flex min-h-32 items-center justify-center p-4"
        >
          <ImageOffIcon className="text-muted-foreground size-8" />
        </div>
      ) : (
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          /* Boxes edit: images load when they scroll into view, because a
             replay puts a whole long thread on the page at once. */
          loading="lazy"
          decoding="async"
          className={cn(
            "block h-auto w-full object-contain",
            !loaded && "invisible",
            className,
          )}
          onLoad={(e) => {
            if (typeof src === "string") setLoadedSrc(src);
            onLoad?.(e);
          }}
          onError={(e) => {
            if (typeof src === "string") setErrorSrc(src);
            onError?.(e);
          }}
          {...props}
        />
      )}
    </div>
  );
}

/**
 * The file name below an image. It renders nothing without a name.
 *
 * @param className Extra classes.
 * @param children The file name.
 * @param props The other span props.
 */
function ImageFilename({
  className,
  children,
  ...props
}: React.ComponentProps<"span">) {
  if (!children) return null;

  return (
    <span
      data-slot="image-filename"
      className={cn(
        "text-muted-foreground block truncate px-2 py-1.5 text-xs",
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

/** The props of {@link ImageZoom}. */
type ImageZoomProps = PropsWithChildren<{
  /** The source of the full image. */
  src: string;
  /** The alt text of the full image. */
  alt?: string;
  /** Boxes edit: classes for the image in the full screen view. */
  contentClassName?: string;
}>;

/**
 * A trigger that shows an image full screen in an overlay. Escape, a click and
 * the close button close it, and the focus stays in the overlay while it is open.
 *
 * @param props The source, the alt text, the classes of the full image and the trigger content.
 */
function ImageZoom({
  src,
  alt = "Image preview",
  contentClassName,
  children,
}: ImageZoomProps) {
  const [isMounted, setIsMounted] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const handleOpen = useCallback(() => setIsOpen(true), []);
  const handleClose = useCallback(() => {
    setIsOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Boxes edit: the back button closes the zoomed image, and the thread stays.
  // The overlay is a plain portal and no Radix root, so it calls the hook itself.
  useHistoryOverlay(isOpen, handleClose);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = overlayRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      const first = focusables?.[0];
      const last = focusables?.[focusables.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleClose]);

  useEffect(() => {
    if (!isOpen) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) closeRef.current?.focus();
  }, [isOpen]);

  return (
    <>
      <div
        ref={triggerRef}
        onClick={handleOpen}
        onKeyDown={(e) => e.key === "Enter" && handleOpen()}
        role="button"
        tabIndex={0}
        className="aui-image-zoom-trigger cursor-zoom-in"
        aria-label="Click to zoom image"
      >
        {children}
      </div>
      {isMounted &&
        isOpen &&
        createPortal(
          <div
            ref={overlayRef}
            data-slot="image-zoom-overlay"
            role="dialog"
            aria-modal="true"
            className="aui-image-zoom-overlay fade-in animate-in fixed inset-0 z-50 flex items-center justify-center bg-black/80 duration-200"
            onClick={handleClose}
            aria-label="Zoomed image"
          >
            <img
              data-slot="image-zoom-content"
              src={src}
              alt={alt}
              className={cn(
                "aui-image-zoom-content fade-in zoom-in-95 animate-in max-h-[90vh] max-w-[90vw] cursor-zoom-out object-contain duration-200",
                contentClassName,
              )}
              onClick={(e) => {
                e.stopPropagation();
                handleClose();
              }}
            />
            <button
              ref={closeRef}
              type="button"
              aria-label="Close zoomed image"
              onClick={(e) => {
                e.stopPropagation();
                handleClose();
              }}
              className="text-muted-foreground hover:text-foreground bg-background/80 absolute end-4 top-4 cursor-pointer rounded-md p-2"
            >
              <XIcon className="size-5" />
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * The placeholder while an image is generated.
 *
 * @param className Extra classes.
 */
function ImageGenerating({ className }: { className?: string }) {
  return (
    <div
      data-slot="image-generating"
      className={cn(
        "bg-muted/50 flex min-h-32 items-center justify-center p-4",
        className,
      )}
    >
      {/* Boxes edit: uses the spinner of the dashboard. */}
      <Spinner className="text-muted-foreground size-8" />
      <span className="sr-only">Generating image…</span>
    </div>
  );
}

/**
 * The notice for an image that the content filter of the provider blocked.
 *
 * @param className Extra classes.
 * @param reason The reason to show, if any.
 */
function ImageContentFilterError({
  className,
  reason,
}: {
  /** Extra classes. */
  className?: string;
  /** The reason to show, if any. */
  reason?: string;
}) {
  return (
    <div
      data-slot="image-content-filter-error"
      className={cn(
        "bg-muted/50 flex min-h-32 flex-col items-center justify-center gap-2 p-4 text-center",
        className,
      )}
    >
      <ShieldAlertIcon className="text-muted-foreground size-8" />
      <p className="text-sm font-medium">Image could not be generated</p>
      {reason && <p className="text-muted-foreground text-xs">{reason}</p>}
    </div>
  );
}

/** The props of {@link ImageActions}. */
export type ImageActionsProps = {
  /** The image part that the actions work on. */
  part: ImageMessagePart;
  /**
   * Called when the user asks to regenerate the image. The regenerate button
   * renders only when this is set.
   */
  onRegenerate?: () => void | Promise<void>;
  /** Extra classes. */
  className?: string;
};

/**
 * The button that regenerates an image. It shows a spinner and is disabled while the call runs.
 *
 * @param onRegenerate Called when the user asks to regenerate the image.
 */
function RegenerateButton({
  onRegenerate,
}: {
  /** Called when the user asks to regenerate the image. */
  onRegenerate: () => void | Promise<void>;
}) {
  const [isRegenerating, setIsRegenerating] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        setIsRegenerating(true);
        try {
          await onRegenerate();
        } catch {
        } finally {
          setIsRegenerating(false);
        }
      }}
      disabled={isRegenerating}
      data-slot="image-regenerate"
      aria-label="Regenerate image"
      className="hover:bg-muted inline-flex size-7 items-center justify-center rounded disabled:opacity-50"
    >
      {/* Boxes edit: uses the spinner of the dashboard while the call runs. */}
      {isRegenerating ? <Spinner /> : <RefreshCwIcon className="size-4" />}
    </button>
  );
}

/**
 * The download, copy and regenerate buttons of an image.
 *
 * @param props The image part, the regenerate callback and the classes.
 */
function ImageActions({ part, onRegenerate, className }: ImageActionsProps) {
  return (
    <div
      data-slot="image-actions"
      className={cn("flex items-center gap-1 p-1", className)}
    >
      <button
        type="button"
        onClick={() => downloadImagePart(part)}
        data-slot="image-download"
        aria-label="Download image"
        className="hover:bg-muted inline-flex size-7 items-center justify-center rounded"
      >
        <DownloadIcon className="size-4" />
      </button>
      <button
        type="button"
        onClick={() => {
          copyImagePart(part).catch(() => {});
        }}
        data-slot="image-copy"
        aria-label="Copy image"
        className="hover:bg-muted inline-flex size-7 items-center justify-center rounded"
      >
        <CopyIcon className="size-4" />
      </button>
      {onRegenerate && <RegenerateButton onRegenerate={onRegenerate} />}
    </div>
  );
}

/**
 * An image part of a message. It shows a placeholder while the image is
 * generated, a notice when the content filter blocked it, and the image with zoom otherwise.
 *
 * @param props The image part.
 */
const ImageImpl: ImageMessagePartComponent = (props) => {
  const { image, filename, status } = props;

  if (status?.type === "running") {
    return (
      <ImageRoot>
        <ImageGenerating />
        <ImageFilename>{filename}</ImageFilename>
      </ImageRoot>
    );
  }

  if (status?.type === "incomplete" && status.reason === "content-filter") {
    return (
      <ImageRoot>
        <ImageContentFilterError reason="The provider blocked this image." />
      </ImageRoot>
    );
  }

  return (
    <ImageRoot>
      <ImageZoom src={image} alt={filename || "Image content"}>
        <ImagePreview src={image} alt={filename || "Image content"} />
      </ImageZoom>
      <ImageFilename>{filename}</ImageFilename>
    </ImageRoot>
  );
};

/** The image part component, with its parts attached for custom layouts. */
const Image = memo(ImageImpl) as unknown as ImageMessagePartComponent & {
  /** The root part. */
  Root: typeof ImageRoot;
  /** The image with its loading and error states. */
  Preview: typeof ImagePreview;
  /** The file name part. */
  Filename: typeof ImageFilename;
  /** The full screen view part. */
  Zoom: typeof ImageZoom;
  /** The action buttons part. */
  Actions: typeof ImageActions;
  /** The placeholder while the image is generated. */
  Generating: typeof ImageGenerating;
  /** The notice for a blocked image. */
  ContentFilterError: typeof ImageContentFilterError;
};

Image.displayName = "Image";
Image.Root = ImageRoot;
Image.Preview = ImagePreview;
Image.Filename = ImageFilename;
Image.Zoom = ImageZoom;
Image.Actions = ImageActions;
Image.Generating = ImageGenerating;
Image.ContentFilterError = ImageContentFilterError;

export {
  Image,
  ImageRoot,
  ImagePreview,
  ImageFilename,
  ImageZoom,
  ImageActions,
  ImageGenerating,
  ImageContentFilterError,
  imageVariants,
};
