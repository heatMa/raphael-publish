/**
 * Node.js image re-hosting utilities (mirrors src/lib/imageRehost.ts for browser).
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

    const json = await res.json() as { success: boolean; data: { url: string }; error?: { message: string } };
    if (!json.success) {
        throw new Error(`imgbb upload failed: ${json.error?.message ?? 'unknown error'}`);
    }

    return json.data.url;
}
