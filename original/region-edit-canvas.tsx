"use client";

import * as React from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Crop, Eraser, ImagePlus, Replace, Sparkles, X, Undo2, Redo2, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { fetcher } from "@/lib/client/api";
import type { PricingConfig, Slide } from "@/lib/types";

interface DisplayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface RegionEditCanvasProps {
  projectId: string;
  slide: Slide;
  imageUrl: string;
  onChanged: () => void;
}

/**
 * Phase 2 核心能力：框选编辑（Region Edit）。
 * 选区坐标换算逻辑直接对齐 Banana Slides 前端的实现思路：
 * 记录 DOM 层的起点/终点 -> 按渲染尺寸与图片 naturalWidth/Height 的比例
 * 换算成图片真实像素坐标，再交给后端做真实的 sharp 像素运算。
 */
export function RegionEditCanvas({ projectId, slide, imageUrl, onChanged }: RegionEditCanvasProps) {
  const [selecting, setSelecting] = React.useState(false);
  const [rect, setRect] = React.useState<DisplayRect | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const [dragStart, setDragStart] = React.useState<{ x: number; y: number } | null>(null);
  const [submitting, setSubmitting] = React.useState<string | null>(null);
  const imgRef = React.useRef<HTMLImageElement>(null);
  const patchInputRef = React.useRef<HTMLInputElement>(null);
  const replaceInputRef = React.useRef<HTMLInputElement>(null);
  const [pendingOp, setPendingOp] = React.useState<"region_overlay" | "replace_full" | null>(null);
  const [instruction, setInstruction] = React.useState("");
  // NEWV7：AI 重绘价格来自 pricing config（前端展示锁定成本）
  const { data: pricingData } = useSWR<{ pricing: PricingConfig }>("/api/pricing", fetcher);
  const regionEditCost = pricingData?.pricing.actionCosts?.regionEdit ?? 3;

  function resetSelection() {
    setSelecting(false);
    setRect(null);
    setDragging(false);
    setDragStart(null);
  }

  function toNaturalSelection() {
    const img = imgRef.current;
    if (!img || !rect) return null;
    const renderedW = img.clientWidth;
    const renderedH = img.clientHeight;
    const scaleX = img.naturalWidth / renderedW;
    const scaleY = img.naturalHeight / renderedH;
    return {
      x: Math.round(rect.left * scaleX),
      y: Math.round(rect.top * scaleY),
      width: Math.round(rect.width * scaleX),
      height: Math.round(rect.height * scaleY),
      imageWidth: img.naturalWidth,
      imageHeight: img.naturalHeight,
    };
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!selecting) return;
    const box = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - box.left;
    const y = e.clientY - box.top;
    setDragging(true);
    setDragStart({ x, y });
    setRect({ left: x, top: y, width: 0, height: 0 });
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!selecting || !dragging || !dragStart) return;
    const box = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - box.left, box.width));
    const y = Math.max(0, Math.min(e.clientY - box.top, box.height));
    setRect({
      left: Math.min(dragStart.x, x),
      top: Math.min(dragStart.y, y),
      width: Math.abs(x - dragStart.x),
      height: Math.abs(y - dragStart.y),
    });
  }

  function handlePointerUp() {
    setDragging(false);
  }

  async function submitOp(operation: "erase_region" | "region_overlay" | "replace_full", patch?: File) {
    const selection = operation === "replace_full" ? undefined : toNaturalSelection();
    if (operation !== "replace_full" && !selection) {
      toast.error("请先框选一个区域");
      return;
    }
    setSubmitting(operation);
    try {
      const form = new FormData();
      form.append("operation", operation);
      if (selection) form.append("selection", JSON.stringify(selection));
      if (patch) form.append("patch", patch);
      const res = await fetch(`/api/projects/${projectId}/slides/${slide.id}/region-edit`, {
        method: "POST",
        body: form,
        credentials: "include",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "处理失败");
      toast.success("已生成新版本，原版本已保留，可在「版本」标签恢复");
      resetSelection();
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "处理失败");
    } finally {
      setSubmitting(null);
    }
  }

  async function submitAiEdit() {
    const selection = toNaturalSelection();
    if (!selection) {
      toast.error("请先框选一个区域");
      return;
    }
    if (!instruction.trim()) {
      toast.error("请填写修改指令（例如：把这段文字改成「XXX」，或换成蓝色科技感图表）");
      return;
    }
    setSubmitting("ai_region_edit");
    try {
      const form = new FormData();
      form.append("operation", "ai_region_edit");
      form.append("selection", JSON.stringify(selection));
      form.append("instruction", instruction.trim());
      const res = await fetch(`/api/projects/${projectId}/slides/${slide.id}/region-edit`, {
        method: "POST",
        body: form,
        credentials: "include",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "处理失败");
      const taskId = json.task?.id as string | undefined;
      resetSelection();
      setInstruction("");
      if (!taskId) {
        toast.success("已生成新版本，原版本已保留，可在「版本」标签恢复");
        onChanged();
        return;
      }
      // AI 重绘由上海 Compute Worker 异步执行：轮询任务直到完成/失败
      toast.info("已提交 AI 重绘，计算节点处理中，可稍后刷新查看结果");
      for (let i = 0; i < 180; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const tRes = await fetch("/api/tasks", { credentials: "include" });
        const tJson = await tRes.json();
        const task = (tJson.tasks ?? []).find((t: { id: string }) => t.id === taskId);
        if (!task) continue;
        if (task.status === "completed") {
          toast.success("AI 重绘完成，原版本已保留，可在「版本」标签恢复");
          onChanged();
          return;
        }
        if (task.status === "failed") {
          throw new Error(task.resultMessage || "AI 重绘失败");
        }
      }
      throw new Error("AI 重绘超时，请稍后在任务中心查看结果");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "处理失败");
    } finally {
      setSubmitting(null);
    }
  }

  const versions = slide.illustration?.versions ?? [];
  const currentIdx = versions.findIndex((v) => v.id === slide.illustration?.currentVersionId);
  const canUndo = currentIdx > 0;
  const canRedo = currentIdx >= 0 && currentIdx < versions.length - 1;

  async function stepVersion(direction: "undo" | "redo") {
    const target = direction === "undo" ? versions[currentIdx - 1] : versions[currentIdx + 1];
    if (!target) return;
    setSubmitting("step");
    try {
      const res = await fetch(`/api/projects/${projectId}/slides/${slide.id}/illustration/set-current`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versionId: target.id }),
        credentials: "include",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "操作失败");
      toast.success(direction === "undo" ? "已撤销到上一个版本" : "已重做到下一个版本");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败");
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="relative">
      <div
        className={cn("relative select-none", selecting && "cursor-crosshair")}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img ref={imgRef} src={imageUrl} alt={slide.title} className="w-full rounded-md shadow-md" draggable={false} />
        {rect && (
          <div
            className="absolute border-2 border-primary bg-primary/15"
            style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
          />
        )}
      </div>

      <div className="mt-2 flex items-center justify-center gap-1.5">
        {!selecting ? (
          <Button size="xs" variant="outline" onClick={() => setSelecting(true)}>
            <Crop className="h-3.5 w-3.5" /> 框选修改
          </Button>
        ) : (
          <Button size="xs" variant="ghost" onClick={resetSelection}>
            <X className="h-3.5 w-3.5" /> 结束框选
          </Button>
        )}
      </div>

      {selecting && rect && rect.width > 4 && rect.height > 4 && (
        <div className="absolute left-1/2 top-full z-20 mt-2 w-72 -translate-x-1/2 rounded-lg border border-border bg-popover p-3 shadow-lg">
          <p className="mb-2 text-xs font-medium text-foreground">
            已选择 {Math.round(rect.width)} × {Math.round(rect.height)} 区域，选择处理方式：
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            <Button size="xs" variant="outline" disabled={!!submitting} onClick={() => submitOp("erase_region")}>
              <Eraser className="h-3.5 w-3.5" /> 智能擦除
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={!!submitting}
              onClick={() => {
                setPendingOp("region_overlay");
                patchInputRef.current?.click();
              }}
            >
              <ImagePlus className="h-3.5 w-3.5" /> 替换选区
            </Button>
          </div>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="描述这个区域要变成什么（例如：把标题改成「XXX」；或换成蓝色科技感图表）"
            rows={2}
            className="mt-2 w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
          />
          <Button
            size="xs"
            className="mt-1 w-full"
            disabled={!!submitting}
            onClick={submitAiEdit}
          >
            <Sparkles className="h-3.5 w-3.5" /> AI 生成式重绘
            <span className="ml-1 flex items-center gap-0.5 rounded bg-primary/20 px-1 py-0.5 text-[10px]">
              <Zap className="h-2.5 w-2.5" /> {regionEditCost}
            </span>
          </Button>
          {submitting && <p className="mt-2 text-center text-[11px] text-muted-foreground">正在处理…</p>}
        </div>
      )}

      <input
        ref={patchInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file && pendingOp) submitOp(pendingOp, file);
        }}
      />

      <div className="mt-2 flex items-center justify-center gap-1.5">
        <Button size="xs" variant="ghost" disabled={!canUndo || !!submitting} onClick={() => stepVersion("undo")}>
          <Undo2 className="h-3.5 w-3.5" /> 撤销
        </Button>
        <Button size="xs" variant="ghost" disabled={!canRedo || !!submitting} onClick={() => stepVersion("redo")}>
          <Redo2 className="h-3.5 w-3.5" /> 重做
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={!!submitting}
          onClick={() => {
            setPendingOp("replace_full");
            replaceInputRef.current?.click();
          }}
        >
          <Replace className="h-3.5 w-3.5" /> 整图替换
        </Button>
        <input
          ref={replaceInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) submitOp("replace_full", file);
          }}
        />
      </div>
    </div>
  );
}
