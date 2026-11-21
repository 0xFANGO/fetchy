"""Extract declared media from an HTML page or a finite DASH manifest without network I/O."""
import json
import sys

from html.parser import HTMLParser
from urllib.parse import urljoin
from xml.etree import ElementTree

class MediaTags(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.base = None
        self.urls = []
        self.title = ''
        self.in_title = False
        self.in_video = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'base' and self.base is None:
            self.base = a.get('href')
        if tag == 'title':
            self.in_title = True
        if tag == 'video':
            self.in_video = True
        name = (a.get('property') or a.get('name') or '').lower()
        if tag == 'video' or (tag == 'source' and self.in_video):
            self.urls.append(a.get('src'))
        if tag == 'meta' and name in ('og:video', 'og:video:url', 'og:video:secure_url', 'twitter:player:stream'):
            self.urls.append(a.get('content'))

    def handle_endtag(self, tag):
        if tag == 'title':
            self.in_title = False
        if tag == 'video':
            self.in_video = False

    def handle_data(self, data):
        if self.in_title:
            self.title += data

class Article(HTMLParser):
    """Read only a semantic article and retain headings, paragraphs, links and media."""
    void = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
            'param', 'source', 'track', 'wbr'}

    def __init__(self, url):
        super().__init__(convert_charrefs=True)
        self.url, self.stack, self.body, self.media, self.headline = url, [], [], [], []
        self.seen, self.cut, self.author = 0, False, ''

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'meta' and a.get('name', '').lower() == 'author':
            self.author = a.get('content', '')
        parent = self.stack[-1][1] if self.stack else 'outside'
        role = parent
        if parent == 'outside' and (tag == 'article' or a.get('itemprop') == 'articleBody'):
            role = 'article'
            self.seen += 1
        elif tag in ('script', 'style', 'nav', 'aside', 'footer', 'form', 'button') or 'hidden' in a or a.get('aria-hidden') == 'true':
            role = 'hidden'
        href = None
        if role == 'article':
            if tag in ('p', 'div', 'section', 'li', 'br', 'blockquote', 'pre'):
                self.body.append('\n')
            if tag in ('h1','h2','h3','h4','h5','h6'):
                self.body.append('\n' + '#' * int(tag[1]) + ' ')
            if tag == 'a' and a.get('href'):
                href = urljoin(self.url, a['href'])
                if href.startswith(('https://','http://')):
                    self.body.append('[')
                else:
                    href = None
            if tag in ('img', 'video') or (tag == 'source' and self.stack and self.stack[-1][0] == 'video'):
                kind = 'image' if tag == 'img' else 'video'
                raw = a.get('src') or a.get('data-src')
                item = {'kind':kind, 'alt':a.get('alt', '')}
                if raw:
                    item['url'] = urljoin(self.url, raw)
                else:
                    item['missing'] = True
                if tag == 'source' and self.media and self.media[-1].get('missing') and self.media[-1]['kind'] == 'video':
                    self.media[-1] = item
                elif tag != 'source':
                    self.media.append(item)
            if 'paywall' in str(a.get('class', '')).lower():
                self.cut = True
        if tag not in self.void:
            self.stack.append((tag, role, href))

    def handle_endtag(self, tag):
        idx = next((i for i in range(len(self.stack)-1,-1,-1) if self.stack[i][0] == tag), None)
        if idx is None:
            return
        _, role, href = self.stack[idx]
        if role == 'article' and href:
            self.body.append('](' + href + ')')
        if role == 'article' and tag in ('p','div','li','blockquote','pre','h1','h2','h3','h4','h5','h6'):
            self.body.append('\n')
        del self.stack[idx:]

    def handle_data(self, data):
        if self.stack and self.stack[-1][1] == 'article':
            self.body.append(data)
            if any(tag == 'h1' for tag, _, _ in self.stack):
                self.headline.append(data)
            if data.strip().lower() in ('read more','subscribe to continue','展开全文','阅读全文'):
                self.cut = True

    def result(self):
        body = '\n'.join(' '.join(line.split()) for line in ''.join(self.body).splitlines() if line.strip())
        if self.seen != 1 or not body:
            return None
        return {'title': ''.join(self.headline).strip(), 'body': body, 'bodyFormat': 'markdown',
                'bodyComplete': not self.cut, 'attachments': self.media, 'author': self.author}


def duration(value):
    """ISO 8601 presentation duration in seconds (years/months are ambiguous)."""
    import re
    match = re.fullmatch(r'P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?', value or '')
    return sum(float(v or 0) * unit for v, unit in zip(match.groups(), (86400, 3600, 60, 1))) if match else 0


def dash(source, url):
    import math
    import re

    if '<!DOCTYPE' in source.upper():
        raise ValueError('unexpected document type')
    root = ElementTree.fromstring(source)
    for el in root.iter():
        el.tag = el.tag.split('}')[-1]
    if root.tag != 'MPD' or root.get('type', 'static') != 'static' or root.find('.//ContentProtection') is not None:
        raise ValueError('unsupported manifest')
    periods = root.findall('Period')
    if len(periods) != 1:
        raise ValueError('multi-period manifests are unsupported')
    period = periods[0]
    length = duration(period.get('duration') or root.get('mediaPresentationDuration'))
    tracks, budget = [], 20000
    for group in period.findall('AdaptationSet'):
        for rep in group.findall('Representation'):
            levels = (root, period, group, rep)
            mime = rep.get('mimeType', group.get('mimeType', ''))
            kind = mime.split('/')[0] or group.get('contentType')
            if kind not in ('video', 'audio'):
                continue
            base = url
            templates, listing = [], None
            for level in levels:
                if level.find('SegmentBase') is not None:
                    raise ValueError('byte ranges are unsupported')
                base = urljoin(base, level.findtext('BaseURL') or '')
                template = level.find('SegmentTemplate')
                if template is not None:
                    templates.append(template)
                if level.find('SegmentList') is not None:
                    listing = level.find('SegmentList')
            urls = []
            if listing is not None:
                for entry in listing:
                    if entry.get('range') or entry.get('mediaRange') or entry.get('indexRange'):
                        raise ValueError('byte ranges are unsupported')
                    uri = entry.get('sourceURL') if entry.tag == 'Initialization' else entry.get('media')
                    if uri:
                        urls.append(urljoin(base, uri))
            elif templates:
                attrs = {}
                timeline = None
                for template in templates:
                    attrs.update(template.attrib)
                    if template.find('SegmentTimeline') is not None:
                        timeline = template.find('SegmentTimeline')
                pattern = attrs['media']
                number, pos = int(attrs.get('startNumber', 1)), 0
                timescale = int(attrs.get('timescale', 1))
                if timescale <= 0:
                    raise ValueError('invalid timescale')

                def expand(pattern, number, pos):
                    def replace(match):
                        name, width = match.groups()
                        if name is None:
                            return '$'
                        value = {'RepresentationID': rep.get('id'), 'Bandwidth': rep.get('bandwidth'),
                                 'Number': number, 'Time': pos}[name]
                        if value is None:
                            raise ValueError('missing template value')
                        return str(value).zfill(int(width or 0))
                    return urljoin(base, re.sub(r'\$\$|\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d{1,2})d)?\$', replace, pattern))

                if attrs.get('initialization'):
                    urls.append(expand(attrs['initialization'], number, pos))
                points = list(timeline.findall('S')) if timeline is not None else []
                if timeline is None:
                    step = int(attrs['duration'])
                    if step <= 0 or length <= 0:
                        raise ValueError('missing finite duration')
                    points = [ElementTree.Element('S', {'d': str(step), 'r': str(math.ceil(length*timescale/step)-1)})]
                for index, point in enumerate(points):
                    pos, step, repeat = int(point.get('t', pos)), int(point.get('d')), int(point.get('r', 0))
                    if step <= 0 or repeat < -1:
                        raise ValueError('invalid timeline')
                    if repeat == -1:
                        end = points[index+1].get('t') if index+1 < len(points) else length*timescale
                        if not end or float(end)<=pos:
                            raise ValueError('unbounded timeline')
                        repeat = math.ceil((float(end)-pos)/step)-1
                    if len(urls)+repeat+1 > budget:
                        raise ValueError('segment limit')
                    for _ in range(repeat+1):
                        urls.append(expand(pattern,number,pos))
                        number += 1
                        pos += step
            elif base != url:
                urls = [base]
            if urls:
                budget -= len(urls)
                if budget < 0:
                    raise ValueError('segment limit')
                tracks.append({'urls': urls, 'audioOnly': kind == 'audio',
                               'height': int(rep.get('height', group.get('height', 0))),
                               'bitrate': int(rep.get('bandwidth', 0))})
    return tracks


if __name__ == '__main__':
    try:
        data = json.load(sys.stdin)
        if data['kind'] == 'dash':
            result = dash(data['text'], data['url'])
        elif data['kind'] == 'article':
            parser = Article(data['url'])
            parser.feed(data['text'])
            result = parser.result()
        else:
            parser = MediaTags()
            parser.feed(data['text'])
            base = urljoin(data['url'], parser.base or '')
            result = {'title': parser.title.strip()[:300], 'urls': list(dict.fromkeys(urljoin(base,u) for u in parser.urls if u))[:32]}
        print(json.dumps(result))
    except Exception:
        sys.exit(1)
