// The native host accepts 48 MiB of UTF-8 JSON. Account for folder rows and
// selection keys before reading originals, then bound inline media across tabs.
const KIB = 1024,
	MIB = KIB * KIB;
const utf8 = new TextEncoder();
const size = (value) => utf8.encode(JSON.stringify(value)).byteLength;
export function safeListing(item) {
	const {visitUrl, ...entry} = item;
	return entry;
}
export function manifestFolder(collection, byKey = new Map()) {
	return {
		...collection.folder,
		total: collection.total,
		pages: collection.pages.map((list, i) => ({
			cursor: i ? 'page-' + i : null,
			nextCursor:
				i + 1 < collection.pages.length ? 'page-' + (i + 1) : collection.complete ? null : 'unread',
			items: list.map((item) => byKey.get(item.platform + ':' + item.id) || safeListing(item)),
		})),
	};
}
export class ArchiveTransfer {
	constructor(
		collections = [],
		selected = undefined,
		{wireLimit = 48 * MIB, inlineLimit = 24 * MIB} = {},
	) {
		this.availableWire =
			wireLimit -
			size({manifest: {version: 1, folders: collections.map((c) => manifestFolder(c))}, selected}) -
			256;
		if (this.availableWire < 0) throw new Error('metadata_limit');
		this.inlineLeft = Math.floor(inlineLimit / 3) * 4;
		this.fallbacks = [];
		this.originals = new Set();
		this.urlCount = 0;
		this.missingCount = 0;
	}
	get readLimit() {
		return Math.max(0, Math.floor((Math.min(this.availableWire, this.inlineLeft) * 3) / 4));
	}
	record(listing, original, hydrated) {
		const entry = safeListing(hydrated);
		this.originals.add(entry.platform + ':' + entry.id);
		entry.attachments = (entry.attachments || []).map((a) => ({...a}));
		for (const [index, asset] of entry.attachments.entries()) {
			if (!asset.data) {
				if (asset.url) this.urlCount++;
				continue;
			}
			const source = original.attachments?.[index];
			const {data, url, ...meta} = asset;
			const fallback =
				source?.url || url ? {...meta, url: source?.url || url} : {...meta, missing: true};
			if (data.length > this.inlineLeft) {
				entry.attachments[index] = fallback;
				this.countFallback(fallback);
				continue;
			}
			this.inlineLeft -= data.length;
			const savings = size(asset) - size(fallback);
			if (savings > 0)
				this.fallbacks.push({
					slots: entry.attachments,
					index,
					fallback,
					chars: data.length,
					savings,
				});
		}
		this.availableWire += size(safeListing(listing)) - size(entry);
		// A later text-only work may need space reserved by an earlier image.
		while (this.availableWire < 0 && this.fallbacks.length) {
			const {slots, index, fallback, chars, savings} = this.fallbacks.pop();
			slots[index] = fallback;
			this.availableWire += savings;
			this.inlineLeft += chars;
			this.countFallback(fallback);
		}
		if (this.availableWire < 0) throw new Error('metadata_limit');
		return entry;
	}
	countFallback(asset) {
		if (asset.url) this.urlCount++;
		else this.missingCount++;
	}
}
