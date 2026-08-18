class CoverImageSource {
  const CoverImageSource._();

  static String? normalizeUrl(String? raw, {int? size}) {
    if (raw == null) return null;
    var url = raw.trim();
    if (url.isEmpty) return url;

    if (url.startsWith('/data/oss/')) {
      url = 'https://d.musicapp.migu.cn$url';
    }

    final candidate = url.startsWith('//') ? 'http:$url' : url;
    final host = Uri.tryParse(candidate)?.host.toLowerCase() ?? '';
    final keepHttp = host == 'kwcdn.kuwo.cn' || host.endsWith('.kwcdn.kuwo.cn');
    if (url.startsWith('//')) {
      url = '${keepHttp ? 'http' : 'https'}:$url';
    } else if (url.startsWith('http://') && !keepHttp) {
      url = url.replaceFirst('http://', 'https://');
    }
    if (size != null && url.contains('music.126.net')) {
      final dimension = RegExp(r'([?&])param=\d+y\d+');
      if (dimension.hasMatch(url)) {
        url = url.replaceFirstMapped(
          dimension,
          (match) => '${match[1]}param=${size}y$size',
        );
      } else {
        final sep = url.contains('?') ? '&' : '?';
        url = '$url${sep}param=${size}y$size';
      }
    }
    if (size != null && (host == 'kuwo.cn' || host.endsWith('.kuwo.cn'))) {
      url = url.replaceFirstMapped(
        RegExp(r'/star/(albumcover|starheads)/\d+/'),
        (match) => '/star/${match[1]}/$size/',
      );
    }
    if (size != null && (host == 'kugou.com' || host.endsWith('.kugou.com'))) {
      url = url
          .replaceAll('{size}', '$size')
          .replaceFirstMapped(
            RegExp(r'/(stdmusic|softhead)/\d+/'),
            (match) => '/${match[1]}/$size/',
          );
    }
    if (size != null && host == 'y.gtimg.cn') {
      final qqSize = size <= 300 ? 300 : (size <= 500 ? 500 : 800);
      url = url.replaceFirstMapped(
        RegExp(r'/T002R\d+x\d+M000'),
        (match) => '/T002R${qqSize}x${qqSize}M000',
      );
    }
    return url;
  }

  static bool isUsableUrl(String? raw, {int? size}) {
    final normalized = normalizeUrl(raw, size: size);
    if (normalized == null || normalized.isEmpty) return false;
    final uri = Uri.tryParse(normalized);
    return uri != null &&
        (uri.scheme == 'http' || uri.scheme == 'https') &&
        uri.host.isNotEmpty;
  }

  static Map<String, String>? headersFor(String? url) {
    if (url == null || !url.contains('music.126.net')) return null;
    return const {
      'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://music.163.com/',
    };
  }
}
