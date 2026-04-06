interface Settings {
    imgbbApiKey: string;
}

const STORAGE_KEY = 'raphael_settings';

const defaults: Settings = { imgbbApiKey: '' };

export function getSettings(): Settings {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return { ...defaults, ...JSON.parse(raw) };
    } catch {}
    return { ...defaults };
}

export function saveSettings(settings: Partial<Settings>): void {
    const current = getSettings();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...settings }));
}
