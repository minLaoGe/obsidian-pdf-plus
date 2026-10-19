import { Component, Notice, TFile } from 'obsidian';
import type PDFPlus from './main';
import type { PDFViewerComponent, PDFViewExtraState } from './typings';

export interface Progress extends PDFViewExtraState { schema: 1; file: string; device: string; revision: number; }
export const ROOT = 'PDF++ Reading Progress';
export function validProgress(value: unknown): value is Progress {
    if (!value || typeof value !== 'object') return false;
    const p = value as Progress;
    return p.schema === 1 && typeof p.file === 'string' && typeof p.device === 'string'
        && Number.isSafeInteger(p.page) && p.page > 0 && Number.isSafeInteger(p.revision) && p.revision > 0
        && ['left', 'top', 'zoom'].every(k => (p as any)[k] === undefined || Number.isFinite((p as any)[k]))
        && (p.zoom === undefined || p.zoom > 0);
}
export function latest(records: Progress[]): Progress | undefined {
    return records.slice().sort((a, b) => b.revision - a.revision || b.device.localeCompare(a.device))[0];
}

/** Plain vault files, one writer per device/session; no Node or desktop-only APIs. */
export class ReadingProgressSync extends Component {
    restored = new WeakMap<PDFViewerComponent, Progress>();
    private device: string = crypto.randomUUID();
    private bound = new WeakMap<PDFViewerComponent, () => void>();
    private generation = new WeakMap<PDFViewerComponent, object>();
    private queue = Promise.resolve();
    private warned = false;
    private cleanups = new Set<() => void>();
    constructor(private plugin: PDFPlus) {
        super();
        // localStorage is local to this client; synced plugin settings must never hold this ID.
        try {
            const key = `pdf-plus-reading-device:${plugin.app.vault.getName()}`;
            const existing = localStorage.getItem(key);
            if (existing && /^[0-9a-f-]{36}$/.test(existing)) this.device = existing;
            else localStorage.setItem(key, this.device);
        } catch { /* Private storage unavailable: use a session-specific writer. */ }
        this.register(() => { for (const cleanup of this.cleanups) cleanup(); });
    }

    private async records(path: string): Promise<Progress[]> {
        const files = this.plugin.app.vault.getFiles().filter(f => f.path.startsWith(ROOT + '/') && f.extension === 'json');
        const records = await Promise.all(files.map(async f => {
            try {
                const data: unknown = JSON.parse(await this.plugin.app.vault.read(f));
                return validProgress(data) && data.file === path ? data : null;
            } catch { return null; } // A partial sync must not prevent opening a PDF.
        }));
        return records.filter((p): p is Progress => p !== null);
    }

    async open(component: PDFViewerComponent, file: TFile, subpath?: string) {
        this.bound.get(component)?.();
        this.restored.delete(component);
        const token = {};
        this.generation.set(component, token);
        if (!this.plugin.settings.readingProgressSync) return;
        const progress = latest(await this.records(file.path));
        if (this.generation.get(component) !== token) return;
        const explicit = !!subpath && subpath !== '#';
        if (progress && !explicit) this.restored.set(component, progress);
        component.then(child => {
            if (this.generation.get(component) !== token) return;
            const viewer = child.pdfViewer.pdfViewer;
            if (!viewer) return;
            let touched = false;
            let disposed = false;
            let timer: number | undefined;
            let last = '';
            const active = () => {
                const leaf = this.plugin.app.workspace.activeLeaf;
                return leaf && this.plugin.lib.isPDFView(leaf.view) && leaf.view.viewer === component
                    && !viewer.container.ownerDocument.hidden;
            };
            const save = () => {
                if (!touched || !this.plugin.settings.readingProgressSync || !viewer.pagesCount) return;
                const location = viewer._location;
                const state: PDFViewExtraState = {
                    page: location?.pageNumber ?? viewer.currentPageNumber,
                    left: location?.left, top: location?.top, zoom: viewer.currentScale
                };
                const signature = JSON.stringify(state);
                if (signature === last) return;
                last = signature;
                const path = file.path;
                const observedAt = Date.now();
                this.queue = this.queue.then(async () => {
                    const known = latest(await this.records(path));
                    const record: Progress = { ...state, schema: 1, file: path, device: this.device,
                        revision: Math.max(observedAt, (known?.revision ?? 0) + 1) };
                    const vault = this.plugin.app.vault;
                    if (!vault.getAbstractFileByPath(ROOT)) {
                        try { await vault.createFolder(ROOT); } catch (error) {
                            if (!vault.getAbstractFileByPath(ROOT)) throw error;
                        }
                    }
                    const key = Array.from(new TextEncoder().encode(path), b => b.toString(16).padStart(2, '0')).join('');
                    // Hash the path to avoid filename length limits, even for deeply nested PDFs.
                    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
                    const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
                    const target = `${ROOT}/${hash}-${this.device}.json`;
                    const existing = vault.getAbstractFileByPath(target);
                    if (existing instanceof TFile) await vault.modify(existing, JSON.stringify(record));
                    else await vault.create(target, JSON.stringify(record));
                }).catch(error => {
                    last = '';
                    console.error('PDF++ reading progress:', error);
                    if (!this.warned) { new Notice('PDF++ 阅读进度保存失败，请检查控制台和同步目录。'); this.warned = true; }
                });
            };
            const interact = () => { if (active()) touched = true; };
            const update = () => {
                if (!touched || !active()) return;
                window.clearTimeout(timer);
                timer = window.setTimeout(save, 700);
            };
            const restore = () => {
                if (!disposed && !touched && !explicit && progress && progress.page <= viewer.pagesCount) {
                    this.plugin.lib.applyPDFViewStateToViewer(viewer, progress);
                }
            };
            const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
            events.forEach(e => viewer.container.addEventListener(e, interact, { passive: true, capture: true }));
            viewer.eventBus.on('updateviewarea', update);
            viewer.eventBus.on('pagesloaded', restore);
            if (viewer.pagesCount) restore();
            const hide = () => { if (viewer.container.ownerDocument.hidden) save(); };
            viewer.container.ownerDocument.addEventListener('visibilitychange', hide);
            const cleanup = () => {
                if (disposed) return;
                disposed = true;
                this.cleanups.delete(cleanup);
                window.clearTimeout(timer);
                save();
                events.forEach(e => viewer.container.removeEventListener(e, interact, true));
                viewer.eventBus.off('updateviewarea', update);
                viewer.eventBus.off('pagesloaded', restore);
                viewer.container.ownerDocument.removeEventListener('visibilitychange', hide);
            };
            this.bound.set(component, cleanup);
            component.register(cleanup);
            this.cleanups.add(cleanup);
        });
    }
}
