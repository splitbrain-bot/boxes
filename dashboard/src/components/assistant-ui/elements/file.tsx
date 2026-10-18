"use client";

import { memo, type FC } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import {
  FileIcon,
  FileTextIcon,
  ImageIcon,
  MusicIcon,
  VideoIcon,
  BracesIcon,
  DownloadIcon,
} from "lucide-react";
import type { FileMessagePartComponent } from "@assistant-ui/react";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/attachments";

/** The class names of a file card for each variant and size. */
const fileVariants = cva(
  "aui-file-root inline-flex items-center gap-3 rounded-lg transition-colors",
  {
    variants: {
      variant: {
        outline: "border-border hover:bg-muted/50 border",
        ghost: "hover:bg-muted/50",
        muted: "bg-muted/50 hover:bg-muted/70",
      },
      size: {
        sm: "px-2.5 py-1.5 text-xs",
        default: "px-3 py-2 text-sm",
        lg: "px-4 py-3 text-base",
      },
    },
    defaultVariants: {
      variant: "outline",
      size: "default",
    },
  },
);

/**
 * Picks the icon for a MIME type.
 *
 * @param mimeType The MIME type of the file.
 * @returns The icon component, or the generic file icon for an unknown type.
 */
function getMimeTypeIcon(mimeType: string): FC<{ className?: string }> {
  const type = mimeType.toLowerCase();
  if (type.startsWith("image/")) {
    return ImageIcon;
  }
  if (type === "application/pdf") {
    return FileTextIcon;
  }
  if (type === "application/json") {
    return BracesIcon;
  }
  if (type.startsWith("text/")) {
    return FileTextIcon;
  }
  if (type.startsWith("audio/")) {
    return MusicIcon;
  }
  if (type.startsWith("video/")) {
    return VideoIcon;
  }
  return FileIcon;
}

/** The form of the file data: a data URI, a URL, raw base64 or an id. */
export type FileDataKind = "data-uri" | "url" | "base64" | "id";

/**
 * Finds the form of the file data. A data URI wins over the given source type
 * `url`. Without a source type, data that is not a data URI or an http URL counts as base64.
 *
 * @param data The file data.
 * @param sourceType The source type from the message part, if any.
 * @returns The form of the data.
 */
function getFileDataKind(
  data: string,
  sourceType?: "url" | "id",
): FileDataKind {
  if (sourceType === "url" && /^data:/i.test(data)) return "data-uri";
  if (sourceType) return sourceType;
  if (/^data:/i.test(data)) return "data-uri";
  if (/^https?:\/\//i.test(data)) return "url";
  return "base64";
}

/**
 * Computes the decoded size of base64 data. A data URI prefix up to the first comma is ignored.
 *
 * @param base64 The base64 data or data URI.
 * @returns The size in bytes.
 */
function getBase64Size(base64: string): number {
  const commaIndex = base64.indexOf(",");
  const base64Data = commaIndex >= 0 ? base64.slice(commaIndex + 1) : base64;
  const padding = (base64Data.match(/=/g) || []).length;
  return Math.floor((base64Data.length * 3) / 4) - padding;
}

/** Boxes edit: the byte formatter of the dashboard, under the name that the upstream registry exports. */
const formatFileSize = formatBytes;

/** The props of {@link FileRoot}: any div prop and the variant props. */
export type FileRootProps = React.ComponentProps<"div"> &
  VariantProps<typeof fileVariants>;

/**
 * The frame of a file card.
 *
 * @param props The variant, the size, the classes, the content and the other div props.
 */
function FileRoot({
  className,
  variant,
  size,
  children,
  ...props
}: FileRootProps) {
  return (
    <div
      data-slot="file-root"
      data-variant={variant}
      data-size={size}
      className={cn(fileVariants({ variant, size, className }))}
      {...props}
    >
      {children}
    </div>
  );
}

/** The props of {@link FileIconDisplay}: any span prop and the MIME type. */
type FileIconDisplayProps = React.ComponentProps<"span"> & {
  /** The MIME type that picks the icon. */
  mimeType?: string;
};

/**
 * The icon of a file card. Children replace the icon for the MIME type.
 *
 * @param props The MIME type, the classes, the content and the other span props.
 */
function FileIconDisplay({
  mimeType,
  className,
  children,
  ...props
}: FileIconDisplayProps) {
  const IconComponent = mimeType ? getMimeTypeIcon(mimeType) : FileIcon;

  return (
    <span
      data-slot="file-icon"
      className={cn("text-muted-foreground shrink-0", className)}
      {...props}
    >
      {children ?? <IconComponent className="size-5" />}
    </span>
  );
}

/**
 * The name of a file, truncated to one line. A missing name shows as "Unnamed file".
 *
 * @param className Extra classes.
 * @param children The name.
 * @param props The other span props.
 */
function FileName({
  className,
  children,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="file-name"
      className={cn("min-w-0 flex-1 truncate font-medium", className)}
      {...props}
    >
      {children || "Unnamed file"}
    </span>
  );
}

/** The props of {@link FileSize}: any span prop and the size. */
type FileSizeProps = React.ComponentProps<"span"> & {
  /** The size in bytes. */
  bytes: number;
};

/**
 * The size of a file in a readable unit.
 *
 * @param props The size, the classes and the other span props.
 */
function FileSize({ bytes, className, ...props }: FileSizeProps) {
  return (
    <span
      data-slot="file-size"
      className={cn("text-muted-foreground shrink-0", className)}
      {...props}
    >
      {formatFileSize(bytes)}
    </span>
  );
}

/** The props of {@link FileDownload}: any anchor prop but href, and the file data. */
type FileDownloadProps = Omit<React.ComponentProps<"a">, "href"> & {
  /** The file data, as a data URI, a URL, base64 or an id. */
  data: string;
  /** The MIME type, for the data URI of base64 data. */
  mimeType: string;
  /** The name for the downloaded file. */
  filename?: string;
  /** The source type from the message part, if any. */
  sourceType?: "url" | "id";
};

/**
 * The download link of a file card. It renders nothing for an id, or for a URL
 * that is not http, https or blob.
 *
 * @param props The file data, the MIME type, the file name, the source type and the other anchor props.
 */
function FileDownload({
  data,
  mimeType,
  filename,
  sourceType,
  className,
  children,
  ...props
}: FileDownloadProps) {
  if (typeof data !== "string") return null;
  const kind = getFileDataKind(data, sourceType);
  if (kind === "id") return null;
  if (kind === "url" && !/^(https?:\/\/|blob:)/i.test(data)) return null;
  const href = kind === "base64" ? `data:${mimeType};base64,${data}` : data;

  return (
    <a
      data-slot="file-download"
      href={href}
      download={filename || "download"}
      {...(kind === "url" && { target: "_blank", rel: "noopener noreferrer" })}
      className={cn(
        "text-muted-foreground hover:bg-accent hover:text-accent-foreground shrink-0 rounded-md p-1 transition-colors",
        className,
      )}
      {...props}
    >
      {children || <DownloadIcon className="size-4" />}
    </a>
  );
}

/**
 * A file part of a message, as a card with icon, name, size and download link.
 * The size shows only for inline data.
 *
 * @param filename The name of the file.
 * @param data The file data.
 * @param mimeType The MIME type of the file.
 * @param sourceType The source type of the data, if any.
 */
const FileImpl: FileMessagePartComponent = ({
  filename,
  data,
  mimeType,
  sourceType,
}) => {
  const kind = getFileDataKind(data, sourceType);
  const showSize =
    typeof data === "string" && (kind === "base64" || kind === "data-uri");

  return (
    <FileRoot>
      <FileIconDisplay mimeType={mimeType} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <FileName>{filename}</FileName>
        {showSize && (
          <FileSize bytes={getBase64Size(data)} className="text-xs" />
        )}
      </div>
      <FileDownload
        data={data}
        mimeType={mimeType}
        {...(filename !== undefined && { filename })}
        {...(sourceType !== undefined && { sourceType })}
      />
    </FileRoot>
  );
};

/** The file part component, with its parts attached for custom layouts. */
const File = memo(FileImpl) as unknown as FileMessagePartComponent & {
  /** The root part. */
  Root: typeof FileRoot;
  /** The icon part. */
  Icon: typeof FileIconDisplay;
  /** The name part. */
  Name: typeof FileName;
  /** The size part. */
  Size: typeof FileSize;
  /** The download link part. */
  Download: typeof FileDownload;
};

File.displayName = "File";
File.Root = FileRoot;
File.Icon = FileIconDisplay;
File.Name = FileName;
File.Size = FileSize;
File.Download = FileDownload;

export {
  File,
  FileRoot,
  FileIconDisplay,
  FileName,
  FileSize,
  FileDownload,
  fileVariants,
  getMimeTypeIcon,
  getFileDataKind,
  getBase64Size,
  formatFileSize,
};
