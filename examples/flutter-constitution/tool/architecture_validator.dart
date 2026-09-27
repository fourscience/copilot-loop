// architecture_validator.dart
//
// Dependency-free (dart:io only) architecture linter for a Flutter app that
// follows an MVVM + vertical-slice-feature layout under lib/:
//
//   lib/features/<feature>/domain/...
//   lib/features/<feature>/data/...
//   lib/features/<feature>/presentation/views/...
//   lib/features/<feature>/presentation/view_models/...
//   lib/features/<feature>/public.dart   (the feature's public barrel)
//
// Enforced rules:
//   mvvm                 - presentation/views/** must not import data/**;
//                           presentation/view_models/** must not import
//                           package:flutter/material.dart or widgets.dart.
//   vertical_slice        - a feature may only reach another feature through
//                           that feature's public.dart barrel, never through
//                           its internal data/domain/presentation files.
//   dependency_direction   - domain/** must not import data/** or
//                           presentation/** (domain has no outward deps).
//
// Output contract (one line per violation, to stdout):
//   <relative/path.dart>:<line>:1: error: <message> [<rule_id>]
//
// Exit code: 1 if any violation was found, 0 otherwise.
import 'dart:io';

final _importRegex = RegExp(
  r'''^\s*import\s+['"]([^'"]+)['"]''',
);

class Violation {
  Violation(this.path, this.line, this.message, this.ruleId);
  final String path;
  final int line;
  final String message;
  final String ruleId;

  @override
  String toString() => '$path:$line:1: error: $message [$ruleId]';
}

/// Resolves an import target to a slash-separated path relative to `lib/`,
/// or null if it is a `dart:` import or a `package:` import that points
/// outside this package's `lib/` (we only care about intra-package imports).
String? resolveToLibRelative(String importerLibRelativePath, String target) {
  if (target.startsWith('dart:')) return null;
  if (target.startsWith('package:')) {
    // package:<name>/<rest> - only meaningful if it is this package's own
    // lib/ (we can't know the package name here reliably without reading
    // pubspec.yaml, so we treat any package: import whose second segment
    // looks like our own tree as unresolved and skip it). Callers that
    // care about package-qualified self-imports should prefer relative
    // imports; this keeps the tool dependency-free and simple.
    return null;
  }
  // Relative import: resolve against the importing file's directory.
  final importerDir = importerLibRelativePath.contains('/')
      ? importerLibRelativePath.substring(
          0, importerLibRelativePath.lastIndexOf('/'))
      : '';
  final segments = <String>[
    ...importerDir.split('/').where((s) => s.isNotEmpty),
    ...target.split('/'),
  ];
  final resolved = <String>[];
  for (final segment in segments) {
    if (segment == '.' || segment.isEmpty) continue;
    if (segment == '..') {
      if (resolved.isNotEmpty) resolved.removeLast();
      continue;
    }
    resolved.add(segment);
  }
  return resolved.join('/');
}

/// Extracts the feature name from a lib-relative path, e.g.
/// "features/auth/domain/user.dart" -> "auth". Returns null if the path is
/// not under lib/features/.
String? featureOf(String libRelativePath) {
  final parts = libRelativePath.split('/');
  if (parts.length < 2 || parts[0] != 'features') return null;
  return parts[1];
}

List<Violation> checkFile(
    String outputPath, String libRelativePath, List<String> lines) {
  final violations = <Violation>[];
  final feature = featureOf(libRelativePath);
  final isView =
      feature != null && libRelativePath.contains('/presentation/views/');
  final isViewModel = feature != null &&
      libRelativePath.contains('/presentation/view_models/');
  final isDomain = feature != null && libRelativePath.contains('/domain/');

  for (var i = 0; i < lines.length; i++) {
    final match = _importRegex.firstMatch(lines[i]);
    if (match == null) continue;
    final target = match.group(1)!;
    final lineNo = i + 1;

    if (isViewModel &&
        (target == 'package:flutter/material.dart' ||
            target == 'package:flutter/widgets.dart')) {
      violations.add(Violation(
        outputPath,
        lineNo,
        'View model must not import Flutter widget/material libraries',
        'mvvm',
      ));
    }

    final resolved = resolveToLibRelative(libRelativePath, target);
    if (resolved == null) continue;

    if (isView && resolved.contains('/data/')) {
      violations.add(Violation(
        outputPath,
        lineNo,
        'View must not import the data layer directly',
        'mvvm',
      ));
    }

    if (isDomain &&
        (resolved.contains('/data/') || resolved.contains('/presentation/'))) {
      violations.add(Violation(
        outputPath,
        lineNo,
        'Domain layer must not depend on data or presentation',
        'dependency_direction',
      ));
    }

    final targetFeature = featureOf(resolved);
    if (feature != null &&
        targetFeature != null &&
        targetFeature != feature) {
      final isPublicBarrel = resolved == 'features/$targetFeature/public.dart';
      if (!isPublicBarrel) {
        violations.add(Violation(
          outputPath,
          lineNo,
          "Cross-feature import must go through '$targetFeature'"
              "'s public.dart barrel, not its internals",
          'vertical_slice',
        ));
      }
    }
  }
  return violations;
}

Future<void> main(List<String> args) async {
  final libDir = Directory('lib');
  if (!libDir.existsSync()) {
    stderr.writeln('error: lib/ directory not found');
    exitCode = 1;
    return;
  }

  final violations = <Violation>[];
  final dartFiles = libDir
      .listSync(recursive: true)
      .whereType<File>()
      .where((f) => f.path.endsWith('.dart'))
      .toList()
    ..sort((a, b) => a.path.compareTo(b.path));

  for (final file in dartFiles) {
    // outputPath: relative path from the project root, e.g.
    // "lib/features/auth/domain/user.dart" - used in reported output.
    // libRelativePath: the same path relative to lib/, e.g.
    // "features/auth/domain/user.dart" - used for import resolution.
    final outputPath = file.path.replaceAll(r'\', '/');
    final libIndex = outputPath.indexOf('lib/');
    final libRelativePath =
        libIndex == -1 ? outputPath : outputPath.substring(libIndex + 4);
    final lines = await file.readAsLines();
    violations.addAll(checkFile(outputPath, libRelativePath, lines));
  }

  for (final v in violations) {
    stdout.writeln(v.toString());
  }

  exitCode = violations.isEmpty ? 0 : 1;
}
