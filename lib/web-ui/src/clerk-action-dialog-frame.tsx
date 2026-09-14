import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";

// Same Radix focus/escape behavior and design tokens as the app dialogs.
export function ClerkActionDialogFrame({
  open,
  close,
  children,
}: {
  open: boolean;
  close: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(value) => !value && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-[50%] top-[50%] z-50 grid max-h-[85vh] w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg">
          {children}
          <Dialog.Close className="absolute right-2 top-2 grid size-8 place-items-center rounded-md opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
            <X className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">Close</span>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ClerkDialogHeader({
  title,
  description,
  descriptionTestId,
  evidence,
}: {
  title: string;
  description: string;
  descriptionTestId?: string;
  evidence?: string | null;
}) {
  return (
    <div className="flex flex-col space-y-1.5 text-center sm:text-left">
      <Dialog.Title className="text-lg font-semibold leading-snug">
        {title}
      </Dialog.Title>
      {evidence && (
        <p
          className="text-sm text-muted-foreground"
          data-testid="text-policy-evidence"
        >
          {evidence}
        </p>
      )}
      <Dialog.Description
        className="text-sm text-muted-foreground"
        data-testid={descriptionTestId}
      >
        {description}
      </Dialog.Description>
    </div>
  );
}

export function ClerkDialogFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2">
      {children}
    </div>
  );
}
