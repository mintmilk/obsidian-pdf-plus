/**
 * Start dragging an PDF outline item, thumbnail image, or annotation popup to 
 * get ready to create a link to the heading in the markdown file.
 * 
 * See `src/patchers/clilpboard-manager.ts` for the editor drop handler.
 */
import { Component, Notice, TFile } from 'obsidian';
import { around } from 'monkey-around';

import PDFPlus from 'main';
import { isAncestorOf } from 'utils';
import { PDFOutlineTreeNode, PDFOutlineViewer, PDFViewerChild } from 'typings';
import { PDFOutlines } from 'lib/outlines';


/** Preserve Obsidian's drag/drop behavior, while owning the DOM listeners its
 * synchronous handleDrag/handleDrop methods install on this one target. */
function registerOwnedDragHandlers(component: Component, el: HTMLElement, register: () => void, restoreDraggable = false) {
    const draggable = el.draggable;
    const restore = around(el, {
        addEventListener(old) {
            return function (this: HTMLElement, ...args: Parameters<HTMLElement['addEventListener']>) {
                old.apply(this, args);
                const [type, listener, options] = args;
                component.register(() => this.removeEventListener(type, listener, options));
            };
        },
    });
    try {
        register();
    } finally {
        restore();
        if (restoreDraggable) component.register(() => { el.draggable = draggable; });
    }
}

export const registerOutlineDrag = async (plugin: PDFPlus, pdfOutlineViewer: PDFOutlineViewer, child: PDFViewerChild, file: TFile) => {
    const { app, lib } = plugin;
    const viewerComponent = child.component;
    const component = child.pdfPlusFileComponent ?? viewerComponent;
    const isActive = () => !!component && (component as Component & { _loaded?: boolean })._loaded !== false
        && child.component === viewerComponent && !child.unloaded && child.file === file;
    if (!component || !isActive()) return;
    const promises: Promise<void>[] = [];

    for (const item of pdfOutlineViewer.allItems) {
        promises.push((async () => {
            const textGenerator = await lib.copyLink.getTextToCopyForOutlineItemDynamic(child, file, item);
            if (!isActive()) return;

            const itemTitle = lib.toSingleLine(item.item.title);
            const title = itemTitle
                ? `${itemTitle.length <= 40 ? itemTitle : itemTitle.slice(0, 39).trim() + '…'}`
                : 'PDF section';

            registerOwnedDragHandlers(component, item.selfEl, () => app.dragManager.handleDrag(item.selfEl, (evt) => {
                if (!isActive()) return null;
                app.dragManager.updateSource([item.selfEl], 'is-being-dragged');
                return {
                    source: 'pdf-plus',
                    type: 'pdf-offset',
                    icon: 'lucide-heading',
                    title,
                    getText: textGenerator,
                    item
                };
            }), true);

            registerOwnedDragHandlers(component, item.selfEl, () => app.dragManager.handleDrop(item.selfEl, (evt, draggable, dragging) => {
                if (!isActive()) return;
                if (!lib.isEditable(child)) return;

                if (!draggable || draggable.source !== 'pdf-plus' || draggable.type !== 'pdf-offset') return;

                // @ts-ignore
                const draggedItem = draggable.item as PDFOutlineTreeNode | undefined;

                if (draggedItem
                    && !isAncestorOf(draggedItem, item, true)
                    && draggedItem.parent !== item
                    && item.owner === draggedItem.owner) {
                    if (!dragging) {
                        (async () => {
                            const outlines = await PDFOutlines.fromFile(file, plugin);
                            const [destItem, itemToMove] = await Promise.all([
                                outlines.findPDFjsOutlineTreeNode(item),
                                outlines.findPDFjsOutlineTreeNode(draggedItem)
                            ]);

                            if (!destItem || !itemToMove) {
                                new Notice(`${plugin.manifest.name}: Failed to move the outline item.`);
                                return;
                            }

                            destItem.appendChild(itemToMove);
                            destItem.sortChildren();
                            const buffer = await outlines.doc.save();
                            await app.vault.modifyBinary(file, buffer);
                        })();
                    }

                    return {
                        action: `Move into "${title}"`,
                        dropEffect: 'move',
                        hoverEl: item.el,
                        hoverClass: 'is-being-dragged-over',
                    };
                }
            }, false));
        })());
    }

    await Promise.all(promises);
    if (!isActive()) return;

    registerOwnedDragHandlers(component, pdfOutlineViewer.childrenEl, () => app.dragManager.handleDrop(pdfOutlineViewer.childrenEl, (evt, draggable, dragging) => {
        if (!isActive()) return;
        if (!lib.isEditable(child)) return;

        if (!draggable || draggable.source !== 'pdf-plus' || draggable.type !== 'pdf-offset') return;

        if (evt.target !== evt.currentTarget) return;

        // @ts-ignore
        const draggedItem = draggable.item as PDFOutlineTreeNode | undefined;

        if (draggedItem && draggedItem.parent && pdfOutlineViewer === draggedItem.owner) {
            if (!dragging) {
                (async () => {
                    const outlines = await PDFOutlines.fromFile(file, plugin);
                    const itemToMove = await outlines?.findPDFjsOutlineTreeNode(draggedItem);

                    if (!itemToMove) {
                        new Notice(`${plugin.manifest.name}: Failed to move the outline item.`);
                        return;
                    }

                    const root = outlines.ensureRoot();
                    root.appendChild(itemToMove);
                    root.sortChildren();
                    const buffer = await outlines.doc.save();
                    await app.vault.modifyBinary(file, buffer);
                })();
            }

            return {
                action: `Move to top level`,
                dropEffect: 'move',
                hoverEl: pdfOutlineViewer.childrenEl,
                hoverClass: 'is-being-dragged-over',
            };
        }
    }, false));
};

export const registerThumbnailDrag = (plugin: PDFPlus, child: PDFViewerChild, file: TFile) => {
    const { app, lib } = plugin;
    const viewerComponent = child.component;
    const component = child.pdfPlusFileComponent ?? viewerComponent;
    const isActive = () => !!component && (component as Component & { _loaded?: boolean })._loaded !== false
        && child.component === viewerComponent && !child.unloaded && child.file === file;
    if (!component || !isActive()) return;

    child.pdfViewer.pdfThumbnailViewer.container
        .querySelectorAll<HTMLElement>('div.thumbnail[data-page-number]')
        .forEach((div) => {
            const pageNumber = parseInt(div.dataset.pageNumber!);
            const pageView = child.getPage(pageNumber);
            const pageLabel = pageView.pageLabel ?? ('' + pageNumber);
            const pageCount = child.pdfViewer.pagesCount;
            const title = ('' + pageNumber === pageLabel)
                ? `Page ${pageNumber}`
                : `Page ${pageLabel} (${pageNumber}/${pageCount})`;

            registerOwnedDragHandlers(component, div, () => app.dragManager.handleDrag(div, (evt) => {
                if (!isActive()) return null;
                app.dragManager.updateSource([div], 'is-being-dragged');
                return {
                    source: 'pdf-plus',
                    type: 'pdf-page',
                    icon: 'lucide-book-open',
                    title,
                    getText: (sourcePath: string) => {
                        return lib.copyLink.getTextToCopy(
                            child,
                            plugin.settings.thumbnailLinkCopyFormat,
                            plugin.settings.thumbnailLinkDisplayTextFormat,
                            file, pageNumber, `#page=${pageNumber}`, '', '', sourcePath
                        );
                    }
                };
            }), true);

        });
};

export const registerAnnotationPopupDrag = (plugin: PDFPlus, popupEl: HTMLElement, child: PDFViewerChild, file: TFile, page: number, id: string, component = child.component) => {
    const { app, lib } = plugin;
    const viewerComponent = child.component;
    const isActive = () => !!component && (component as Component & { _loaded?: boolean })._loaded !== false
        && child.component === viewerComponent && !child.unloaded && child.file === file;
    if (!component || !isActive()) return;

    const pageView = child.getPage(page);

    return child.getAnnotatedText(pageView, id)
        .then((text): void => {
            if (!isActive()) return;
            registerOwnedDragHandlers(component, popupEl, () => app.dragManager.handleDrag(popupEl, (evt) => {
                if (!isActive()) return null;
                app.dragManager.updateSource([popupEl], 'is-being-dragged');
                const palette = lib.getColorPaletteFromChild(child);
                if (!palette) return null;
                const template = plugin.settings.copyCommands[palette.actionIndex].template;

                return {
                    source: 'pdf-plus',
                    type: 'pdf-annotation',
                    icon: 'lucide-highlighter',
                    title: 'PDF annotation',
                    getText: (sourcePath: string) => {
                        return lib.copyLink.getTextToCopy(child, template, undefined, file, page, `#page=${page}&annotation=${id}`, text ?? '', '', sourcePath);
                    }
                };
            }), true);
        });
};
