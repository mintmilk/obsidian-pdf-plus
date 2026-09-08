import { Menu } from 'obsidian';
import { around } from 'monkey-around';

import PDFPlus from 'main';


export const patchMenu = (plugin: PDFPlus) => {
    let active = true;
    plugin.register(around(Menu.prototype, {
        showAtPosition(old) {
            return function (this: Menu, ...args: any[]) {
                if (plugin.settings.hoverableDropdownMenuInToolbar && this.parentEl?.closest('div.pdf-toolbar')) {
                    this.setUseNativeMenu(false);
                }
                // Native showAtPosition returns immediately for an empty menu, without hide().
                if (active && this.items.length) plugin.shownMenus.add(this);
                else plugin.shownMenus.delete(this);
                try {
                    return old.call(this, ...args);
                } catch (error) {
                    plugin.shownMenus.delete(this);
                    throw error;
                }
            };
        },
        hide(old) {
            return function (this: Menu, ...args: any[]) {
                plugin.shownMenus.delete(this);
                return old.call(this, ...args);
            };
        }
    }));
    plugin.register(() => {
        active = false;
        const menus = [...plugin.shownMenus];
        plugin.shownMenus.clear();
        for (const menu of menus) {
            try { menu.hide(); } catch (error) { console.error(error); }
        }
    });
};
