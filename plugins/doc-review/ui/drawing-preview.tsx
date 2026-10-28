import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export function DrawingPreview({ src, seq }: { src: string; seq: number }) {
  const title = `Рисунок к комментарию №${seq}`;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" aria-label={`Открыть: ${title}`} className="mt-1.5 block w-full cursor-zoom-in rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={(event) => event.stopPropagation()}>
          <img src={src} alt={title} loading="lazy" className="max-h-40 w-full rounded border border-border bg-muted object-contain" />
        </button>
      </DialogTrigger>
      <DialogContent className="w-[95vw] max-w-[1400px] sm:max-w-[1400px]" aria-describedby={undefined} onClick={(event) => event.stopPropagation()}>
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div className="max-h-[80vh] overflow-auto">
          <img src={src} alt={title} className="mx-auto max-h-[75vh] max-w-full object-contain" />
        </div>
      </DialogContent>
    </Dialog>
  );
}
