import { Component, Modal } from 'obsidian';

import PDFPlus from 'main';
import { PDFPlusLib } from 'lib';


export class PDFPlusModal extends Modal {
    plugin: PDFPlus;
    lib: PDFPlusLib;
    component: Component;
    private openOwner: Component | undefined;

    constructor(plugin: PDFPlus) {
        super(plugin.app);
        this.plugin = plugin;
        this.lib = plugin.lib;
        this.component = new Component();
        this.contentEl.addClass('pdf-plus-modal');
    }

    onOpen() {
        const previousOwner = this.openOwner;
        this.openOwner = undefined;
        if (previousOwner) this.plugin.removeChild(previousOwner);
        this.component.unload();
        this.component = new Component();
        this.component.load();
        const owner = new Component();
        this.openOwner = owner;
        owner.register(() => {
            if (this.openOwner === owner) {
                this.openOwner = undefined;
                this.close();
            }
        });
        this.plugin.addChild(owner);
        owner.load();
    }

    protected isCurrentOpen(component: Component) {
        return !!this.openOwner && this.component === component;
    }

    onClose() {
        const owner = this.openOwner;
        this.openOwner = undefined;
        if (owner) this.plugin.removeChild(owner);
        this.component.unload();
        this.contentEl.empty();
    }
}
