/**
 * Fetch a remote image URL and return it as a base64 data URL.
 * Falls back to the original URL on network or CORS errors.
 */
export async function fetchImageAsDataUrl(src: string): Promise<string> {
    if (src.startsWith('data:')) return src;
    try {
        const res = await fetch(src, { mode: 'cors', cache: 'default' });
        if (!res.ok) return src;
        const blob = await res.blob();
        return new Promise(resolve => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = () => resolve(src);
            reader.readAsDataURL(blob);
        });
    } catch {
        return src;
    }
}

/**
 * Upload a base64 data URL image to imgbb and return the permanent public URL.
 * Throws if the upload fails.
 */
export async function uploadToImgbb(dataUrl: string, apiKey: string): Promise<string> {
    const base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');

    const formData = new FormData();
    formData.append('key', apiKey);
    formData.append('image', base64);

    const res = await fetch('https://api.imgbb.com/1/upload', {
        method: 'POST',
        body: formData,
    });

    if (!res.ok) {
        throw new Error(`imgbb upload failed (HTTP ${res.status})`);
    }

    const json = await res.json();
    if (!json.success) {
        throw new Error(`imgbb upload failed: ${json.error?.message ?? 'unknown error'}`);
    }

    return json.data.url as string;
}
