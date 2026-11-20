#!/usr/bin/env python3
"""Extract cookies for an explicit list of hosts from a local browser using yt-dlp."""

import json
import sys
import time

SUPPORTED = {'chrome', 'safari', 'edge', 'firefox', 'brave', 'chromium', 'vivaldi', 'opera'}


def matches_host(host: str, domain: str) -> bool:
    h = host.lower().strip()
    d = domain.lower().strip()
    if not h or not d:
        return False
    if d.startswith('.'):
        return h == d[1:] or h.endswith(d)
    return h == d


def emit_error(code: str, message: str) -> None:
    sys.stdout.write(json.dumps({'ok': False, 'error': code, 'message': message}))
    sys.exit(1)


def main() -> None:
    if len(sys.argv) != 3:
        emit_error('invalid_options', '需要提供浏览器名称与站点域名。')
    browser = sys.argv[1].strip().lower()
    hosts = [h.strip().lower() for h in sys.argv[2].split(',') if h.strip()]
    if browser not in SUPPORTED or not hosts:
        emit_error('invalid_options', '不支持的浏览器或域名。')
    try:
        from yt_dlp.cookies import extract_cookies_from_browser
    except Exception:
        emit_error('unavailable', '缺少本机依赖 yt-dlp，请先运行 npm run deps:install。')

    try:
        jar = extract_cookies_from_browser(browser)
    except PermissionError:
        if browser == 'safari':
            emit_error(
                'permission_denied',
                '无法读取 Safari Cookie：请在「系统设置 → 隐私与安全性 → 完全磁盘访问权限」中允许 Fetchy。',
            )
        emit_error('permission_denied', f'系统拒绝读取 {browser} 的登录信息。')
    except FileNotFoundError:
        emit_error('browser_not_found', f'本机未找到 {browser} 浏览器数据目录。')
    except Exception as exc:
        text = str(exc).lower()
        if 'operation not permitted' in text or 'permission' in text or 'keychain' in text:
            if browser == 'safari':
                emit_error(
                    'permission_denied',
                    '无法读取 Safari Cookie：请在「系统设置 → 隐私与安全性 → 完全磁盘访问权限」中允许 Fetchy。',
                )
            emit_error('permission_denied', f'无法读取 {browser} 的登录信息（需要钥匙串或磁盘访问授权）。')
        if 'could not find' in text or 'no such file' in text:
            emit_error('browser_not_found', f'本机未找到 {browser} 浏览器配置。')
        emit_error('unavailable', f'无法从 {browser} 读取登录信息。')

    now = time.time()
    rows = []
    for cookie in jar:
        domain = cookie.domain or ''
        if not any(matches_host(h, domain) for h in hosts):
            continue
        expires = cookie.expires or 0
        if expires and expires <= now:
            continue
        http_only = bool(
            cookie._rest.get('HttpOnly')
            or cookie._rest.get('httponly')
            or 'HttpOnly' in cookie._rest
            or 'httponly' in cookie._rest
        )
        rows.append(
            {
                'name': str(cookie.name or ''),
                'value': str(cookie.value or ''),
                'domain': domain,
                'path': str(cookie.path or '/'),
                'secure': bool(cookie.secure),
                'httpOnly': http_only,
                'expires': float(expires) if expires else 0,
            }
        )
    sys.stdout.write(json.dumps({'ok': True, 'cookies': rows}))


if __name__ == '__main__':
    main()
