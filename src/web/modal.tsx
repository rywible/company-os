import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";

export function Modal({
  title,
  className,
  close,
  children,
}: {
  title: string;
  className?: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={className}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button type="button" aria-label="Close dialog" onClick={close}>
          <X size={17} />
        </button>
      </header>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
