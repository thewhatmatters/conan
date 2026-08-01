import { useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import {
  Layout,
  LayoutContent,
  LayoutFooter,
} from "@astryxdesign/core/Layout";
import { TextInput } from "@astryxdesign/core/TextInput";

export interface RenameThreadDialogProps {
  isOpen: boolean;
  currentTitle: string;
  onOpenChange: (isOpen: boolean) => void;
  onSave: (title: string) => Promise<void>;
}

export default function RenameThreadDialog({
  isOpen,
  currentTitle,
  onOpenChange,
  onSave,
}: RenameThreadDialogProps) {
  const [title, setTitle] = useState(currentTitle);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    setTitle(currentTitle);
    setError(null);
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [currentTitle, isOpen]);

  const close = () => {
    if (!saving) onOpenChange(false);
  };

  const submit = async () => {
    const nextTitle = title.trim();
    if (!nextTitle || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(nextTitle);
      onOpenChange(false);
    } catch {
      setError("Couldn't rename this thread. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      purpose="form"
      width={400}
    >
      <Layout
        height="auto"
        header={
          <DialogHeader
            title="Rename thread"
            subtitle={`Update title for \`${currentTitle}\``}
            onOpenChange={() => close()}
          />
        }
        content={
          <LayoutContent isScrollable={false}>
            <TextInput
              ref={inputRef}
              label="Thread title"
              value={title}
              onChange={(value) => {
                setTitle(value);
                setError(null);
              }}
              onEnter={() => void submit()}
              hasAutoFocus
              isDisabled={saving}
              status={error ? { type: "error", message: error } : undefined}
              width="100%"
            />
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end" align="center">
              <Button
                label="Cancel"
                variant="ghost"
                onClick={close}
                isDisabled={saving}
              />
              <Button
                label="Save"
                variant="primary"
                onClick={() => void submit()}
                isDisabled={!title.trim() || saving}
                isLoading={saving}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
