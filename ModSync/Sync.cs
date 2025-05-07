using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using ModSync.Utility;

namespace ModSync;

using SyncPathFileList = Dictionary<string, List<string>>;
using SyncPathModFiles = Dictionary<string, Dictionary<string, ModFile>>;

public static class Sync
{
    public static SyncPathFileList GetAddedFiles(List<SyncPath> syncPaths, SyncPathModFiles localModFiles, SyncPathModFiles remoteModFiles)
    {
        return syncPaths
            .Select(syncPath => new KeyValuePair<string, List<string>>(
                syncPath.path,
                remoteModFiles[syncPath.path]
                    .Where((kvp) => !kvp.Value.directory)
                    .Select((kvp) => kvp.Key)
                    .Except(localModFiles.TryGetValue(syncPath.path, out var modFiles) ? modFiles.Keys : new List<string>(), StringComparer.OrdinalIgnoreCase)
                    .ToList()
            ))
            .ToDictionary(kvp => kvp.Key, kvp => kvp.Value);
    }

    public static SyncPathFileList GetUpdatedFiles(
        List<SyncPath> syncPaths,
        SyncPathModFiles localModFiles,
        SyncPathModFiles remoteModFiles,
        SyncPathModFiles previousRemoteModFiles
    )
    {
        return syncPaths
            .Select(syncPath =>
            {
                if (!localModFiles.TryGetValue(syncPath.path, out var localPathFiles))
                    return new KeyValuePair<string, List<string>>(syncPath.path, []);

                var query = remoteModFiles[syncPath.path].Keys.Intersect(localPathFiles.Keys, StringComparer.OrdinalIgnoreCase);

                if (!syncPath.enforced)
                    query = query.Where(file =>
                        !previousRemoteModFiles.TryGetValue(syncPath.path, out var previousPathFiles)
                        || !previousPathFiles.TryGetValue(file, out var modFile)
                        || remoteModFiles[syncPath.path][file].hash != modFile.hash
                    );

                query = query.Where(file => remoteModFiles[syncPath.path][file].hash != localPathFiles[file].hash);

                return new KeyValuePair<string, List<string>>(syncPath.path, query.ToList());
            })
            .ToDictionary(kvp => kvp.Key, kvp => kvp.Value);
    }

    public static SyncPathFileList GetRemovedFiles(
        List<SyncPath> syncPaths,
        SyncPathModFiles localModFiles,
        SyncPathModFiles remoteModFiles,
        SyncPathModFiles previousRemoteModFiles
    )
    {
        return syncPaths
            .Select(syncPath =>
            {
                if (!localModFiles.TryGetValue(syncPath.path, out var localPathFiles))
                    return new KeyValuePair<string, List<string>>(syncPath.path, []);

                IEnumerable<string> query;
                if (syncPath.enforced)
                    query = localPathFiles.Keys.Except(remoteModFiles[syncPath.path].Keys, StringComparer.OrdinalIgnoreCase);
                else
                    query = !previousRemoteModFiles.TryGetValue(syncPath.path, out var previousPathFiles)
                        ? []
                        : previousPathFiles
                            .Keys.Intersect(localPathFiles.Keys, StringComparer.OrdinalIgnoreCase)
                            .Except(remoteModFiles[syncPath.path].Keys, StringComparer.OrdinalIgnoreCase);

                return new KeyValuePair<string, List<string>>(syncPath.path, query.ToList());
            })
            .ToDictionary(kvp => kvp.Key, kvp => kvp.Value);
    }

    public static SyncPathFileList GetCreatedDirectories(
        string basePath,
        List<SyncPath> syncPaths,
        SyncPathModFiles localModFiles,
        SyncPathModFiles remoteModFiles
    )
    {
        return syncPaths
            .Select(syncPath =>
            {
                return new KeyValuePair<string, List<string>>(
                    syncPath.path,
                    remoteModFiles[syncPath.path]
                        .Where((kvp) => kvp.Value.directory)
                        .Select((kvp) => kvp.Key)
                        .Except(localModFiles[syncPath.path].Keys, StringComparer.OrdinalIgnoreCase)
                        .Where((dir) => !Directory.Exists(Path.Combine(basePath, dir)))
                        .ToList()
                );
            })
            .ToDictionary((kvp) => kvp.Key, (kvp) => kvp.Value);
    }

    private static List<string> GetFilesInDirectory(string basePath, string directory, List<Regex> exclusions)
    {
        if (File.Exists(directory))
            return [directory];

        if (!Directory.Exists(directory))
            return [];

        return Directory
            .GetFiles(directory, "*", SearchOption.TopDirectoryOnly)
            .Where((file) => !IsExcluded(exclusions, file.Replace($"{basePath}\\", "")))
            .Concat(
                Directory
                    .GetDirectories(directory, "*", SearchOption.TopDirectoryOnly)
                    .Where((subDir) => !IsExcluded(exclusions, subDir.Replace($"{basePath}\\", "")))
                    .SelectMany((subDir) => Directory.GetFileSystemEntries(subDir).Length == 0 ? [subDir] : GetFilesInDirectory(basePath, subDir, exclusions))
            )
            .ToList();
    }

    public static async Task<SyncPathModFiles> HashLocalFiles(
        string basePath,
        List<SyncPath> syncPaths,
        List<Regex> remoteExclusions,
        List<Regex> localExclusions
    )
    {
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var processedFiles = new HashSet<string>();
        var limitOpenFiles = new SemaphoreSlim(1024);

        var results = new SyncPathModFiles();

        foreach (var syncPath in syncPaths)
        {
            var path = Path.Combine(basePath, syncPath.path);

            results[syncPath.path] = (
                await Task.WhenAll(
                    GetFilesInDirectory(basePath, path, [.. remoteExclusions, .. syncPath.enforced ? [] : localExclusions])
                        .Where((file) => !processedFiles.Contains(file))
                        .AsParallel()
                        .Select(
                            async (file) =>
                            {
                                await limitOpenFiles.WaitAsync();
                                var modFile = await CreateModFile(file);
                                limitOpenFiles.Release();

                                processedFiles.Add(file);
                                return new KeyValuePair<string, ModFile>(file.Replace($"{basePath}\\", ""), modFile);
                            }
                        )
                )
            ).ToDictionary(kvp => kvp.Key, kvp => kvp.Value, StringComparer.OrdinalIgnoreCase);
        }

        watch.Stop();
        Plugin.Logger.LogInfo($"Corter-ModSync: Hashed {processedFiles.Count} files in {watch.Elapsed.TotalMilliseconds}ms");

        return results;
    }

    public static async Task<ModFile> CreateModFile(string file)
    {
        var hash = "";

        if (Directory.Exists(file))
            return new ModFile(hash, true);

        try
        {
            hash = await ImoHash.HashFile(file);
        }
        catch (Exception e)
        {
            Plugin.Logger.LogError($"Corter-ModSync: Error hashing '{file}': {e.Message}");
            hash = "";
        }

        return new ModFile(hash);
    }

    public static void CompareModFiles(
        string basePath,
        List<SyncPath> syncPaths,
        SyncPathModFiles localModFiles,
        SyncPathModFiles remoteModFiles,
        SyncPathModFiles previousSync,
        out SyncPathFileList addedFiles,
        out SyncPathFileList updatedFiles,
        out SyncPathFileList removedFiles,
        out SyncPathFileList createdDirectories
    )
    {
        addedFiles = GetAddedFiles(syncPaths, localModFiles, remoteModFiles);
        updatedFiles = GetUpdatedFiles(syncPaths, localModFiles, remoteModFiles, previousSync);
        removedFiles = GetRemovedFiles(syncPaths, localModFiles, remoteModFiles, previousSync);
        createdDirectories = GetCreatedDirectories(basePath, syncPaths, localModFiles, remoteModFiles);
    }

    public static bool IsExcluded(List<Regex> exclusions, string path)
    {
        return exclusions.Any(regex => regex.IsMatch(path.Replace(@"\", "/")));
    }
}
