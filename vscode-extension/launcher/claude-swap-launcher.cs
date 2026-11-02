// claude-swap-launcher: starts Claude Code for Anthropic's VS Code extension and
// picks which login it uses from the folder it starts in.
//
// Claude Swap sets this program as `claudeCode.claudeProcessWrapper`. Anthropic's
// extension then runs `<this exe> <its bundled claude.exe> <claude args...>` with
// the working directory set to the window's folder (fn `lB`/`Ua` in its
// extension.js, 2.1.314), and talks to claude over the standard handles it gave
// this process.
//
// In order, this program:
//  1. Looks the working directory up in ..\folder-map.tsv: `<folder>\t<login
//     folder>` lines, written by Claude Swap. The nearest folder containing the
//     working directory wins. On a match it sets CLAUDE_CONFIG_DIR to that login
//     folder; otherwise it changes nothing, so the main login is used.
//  2. Starts claude.exe on THIS process's standard handles, so the extension and
//     claude talk directly. Nothing here reads or writes them.
//  3. Records the run in ..\sessions\<launcher pid>.json (which window's process
//     started it, which login it uses) so Claude Swap can show it. The record is
//     deleted on exit, and Claude Swap prunes records whose processes are gone.
//  4. Exits with claude's exit code.
//
// It must never be the reason Claude fails to start. Every step before the start
// falls back to "change nothing". Only a failure to start claude.exe itself is
// reported, on stderr with exit code 1, which Anthropic's extension shows as
// "Claude Code could not be started".
//
// Written for the C# 5 compiler that ships with .NET Framework 4.x
// (%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe), so building it needs
// nothing installed: no string interpolation, no ?. and no => members.

using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class Launcher
{
    /// <summary>The Claude Swap data folder: the parent of this exe's folder.</summary>
    private static string root;

    private static int Main(string[] args)
    {
        if (args.Length == 0)
        {
            Console.Error.WriteLine("claude-swap-launcher: no program to start was given.");
            return 1;
        }

        string cwd = SafeCurrentDirectory();
        string loginFolder = null;
        try
        {
            string exe = System.Reflection.Assembly.GetExecutingAssembly().Location;
            root = Path.GetDirectoryName(Path.GetDirectoryName(exe));
            loginFolder = FindLoginFolder(Path.Combine(root, "folder-map.tsv"), cwd);
            if (loginFolder != null && !Directory.Exists(loginFolder))
            {
                Log("login folder " + loginFolder + " is missing; " + cwd + " uses the main login");
                loginFolder = null;
            }
        }
        catch (Exception e)
        {
            Log("folder map unreadable, using the main login: " + e.Message);
            loginFolder = null;
        }

        if (loginFolder != null)
        {
            Environment.SetEnvironmentVariable("CLAUDE_CONFIG_DIR", loginFolder);
        }

        Native.PROCESS_INFORMATION pi;
        try
        {
            pi = Start(args[0]);
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("claude-swap-launcher: could not start " + args[0] + ": " + e.Message);
            Log("start failed: " + e.Message);
            return 1;
        }

        Log("started claude pid " + pi.dwProcessId + " in " + cwd + " with " +
            (loginFolder == null ? "the main login" : "login folder " + loginFolder));
        string record = WriteSessionRecord(pi.dwProcessId, cwd, loginFolder);
        try
        {
            Native.WaitForSingleObject(pi.hProcess, Native.INFINITE);
            uint code;
            if (!Native.GetExitCodeProcess(pi.hProcess, out code))
            {
                code = 1;
            }
            return unchecked((int)code);
        }
        finally
        {
            DeleteQuietly(record);
            Native.CloseHandle(pi.hThread);
            Native.CloseHandle(pi.hProcess);
        }
    }

    /// <summary>
    /// The login folder for <paramref name="cwd"/>, or null for the main login.
    /// Must match folderMap.ts `bindingFor`: case-insensitive, whole path segments,
    /// the longest (nearest) folder wins.
    /// </summary>
    internal static string FindLoginFolder(string mapPath, string cwd)
    {
        if (cwd == null || !File.Exists(mapPath))
        {
            return null;
        }
        string target = Normalize(cwd);
        string best = null;
        int bestLength = -1;
        foreach (string raw in File.ReadAllLines(mapPath, Encoding.UTF8))
        {
            string line = raw.TrimEnd('\r');
            if (line.Length == 0 || line[0] == '#')
            {
                continue;
            }
            int tab = line.IndexOf('\t');
            if (tab <= 0 || tab == line.Length - 1)
            {
                continue;
            }
            string folder = Normalize(line.Substring(0, tab));
            if (Contains(folder, target) && folder.Length > bestLength)
            {
                best = line.Substring(tab + 1);
                bestLength = folder.Length;
            }
        }
        return best;
    }

    private static string Normalize(string path)
    {
        return Path.GetFullPath(path).TrimEnd('\\', '/');
    }

    private static bool Contains(string folder, string path)
    {
        if (string.Equals(folder, path, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }
        return path.Length > folder.Length
            && path.StartsWith(folder, StringComparison.OrdinalIgnoreCase)
            && (path[folder.Length] == '\\' || path[folder.Length] == '/');
    }

    /// <summary>
    /// Start the program with this process's standard handles and environment.
    ///
    /// The child's command line is the tail of OUR command line, passed verbatim, not
    /// re-quoted from parsed arguments. Claude's arguments carry JSON (an inline
    /// --mcp-config, for one) full of quotes and backslashes, and a parse/re-quote
    /// round trip is exactly where such strings get mangled.
    ///
    /// Claude is put in a job that kills it if this launcher dies first (the
    /// extension stops a session by terminating the process it started, which is
    /// this one). SILENT_BREAKAWAY_OK keeps claude's own children OUT of that job:
    /// a program Claude opens for you (an editor, Blender) must not be killed when the
    /// Claude tab closes, just as it is not without the launcher.
    /// </summary>
    private static Native.PROCESS_INFORMATION Start(string program)
    {
        string commandLine = ArgumentsAfterProgram(Marshal.PtrToStringUni(Native.GetCommandLineW()));
        StringBuilder mutableCommandLine = new StringBuilder(commandLine, commandLine.Length + 1);

        Native.STARTUPINFOEX si = new Native.STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(Native.STARTUPINFOEX));
        si.StartupInfo.dwFlags = Native.STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = Inheritable(Native.GetStdHandle(Native.STD_INPUT_HANDLE));
        si.StartupInfo.hStdOutput = Inheritable(Native.GetStdHandle(Native.STD_OUTPUT_HANDLE));
        si.StartupInfo.hStdError = Inheritable(Native.GetStdHandle(Native.STD_ERROR_HANDLE));

        // Started by the extension with no console window (libuv's windowsHide sets
        // CREATE_NO_WINDOW), so give claude none either. Without this, a console
        // program started by a window-less parent gets a NEW, visible console.
        uint flags = Native.CREATE_SUSPENDED;
        if (Native.GetConsoleWindow() == IntPtr.Zero)
        {
            flags |= Native.CREATE_NO_WINDOW;
        }

        // Hand claude exactly its three standard handles and nothing else. Inheriting
        // "every inheritable handle" instead leaked a second reference to the
        // extension's output pipe into programs claude starts (measured 2026-11-02: a
        // background program kept the session's output open for its whole 6 s life
        // under the launcher, 1 ms without it), and the extension reads end-of-output
        // as "the session ended".
        IntPtr handleList = IntPtr.Zero;
        IntPtr attributes = BuildHandleList(si.StartupInfo, out handleList);
        if (attributes != IntPtr.Zero)
        {
            si.lpAttributeList = attributes;
            flags |= Native.EXTENDED_STARTUPINFO_PRESENT;
        }
        else
        {
            si.StartupInfo.cb = Marshal.SizeOf(typeof(Native.STARTUPINFO));
            Log("could not limit the handles claude inherits; starting it the plain way");
        }

        IntPtr job = CreateKillOnCloseJob();
        Native.PROCESS_INFORMATION pi;
        string applicationName = Path.IsPathRooted(program) ? program : null;
        bool started = Native.CreateProcess(applicationName, mutableCommandLine, IntPtr.Zero, IntPtr.Zero, true,
            flags, IntPtr.Zero, null, ref si, out pi);
        int error = Marshal.GetLastWin32Error();
        FreeHandleList(attributes, handleList);
        if (!started)
        {
            if (job != IntPtr.Zero)
            {
                Native.CloseHandle(job);
            }
            throw new Win32Exception(error);
        }
        if (job != IntPtr.Zero && !Native.AssignProcessToJobObject(job, pi.hProcess))
        {
            Log("could not tie claude to the launcher's lifetime (error " + Marshal.GetLastWin32Error() + ")");
        }
        Native.ResumeThread(pi.hThread);
        // The job handle stays open for this process's lifetime on purpose: closing it
        // is what kills claude, and that must happen only if this process dies.
        return pi;
    }

    /// <summary>
    /// Everything after the first token of a Windows command line. The first token
    /// follows the argv[0] rule (CommandLineToArgvW): quoted, it runs to the next
    /// quote with no escapes; unquoted, to the first space or tab.
    /// </summary>
    internal static string ArgumentsAfterProgram(string commandLine)
    {
        int i = 0;
        if (commandLine.Length > 0 && commandLine[0] == '"')
        {
            i = 1;
            while (i < commandLine.Length && commandLine[i] != '"')
            {
                i++;
            }
            if (i < commandLine.Length)
            {
                i++;
            }
        }
        else
        {
            while (i < commandLine.Length && commandLine[i] != ' ' && commandLine[i] != '\t')
            {
                i++;
            }
        }
        while (i < commandLine.Length && (commandLine[i] == ' ' || commandLine[i] == '\t'))
        {
            i++;
        }
        return commandLine.Substring(i);
    }

    /// <summary>
    /// A PROC_THREAD_ATTRIBUTE_HANDLE_LIST naming only the distinct standard
    /// handles, or IntPtr.Zero when one cannot be built (the caller then falls back
    /// to plain inheritance). The list must not repeat a handle, or CreateProcess
    /// fails with ERROR_INVALID_PARAMETER, and stdout and stderr can be the same.
    /// </summary>
    private static IntPtr BuildHandleList(Native.STARTUPINFO si, out IntPtr handleArray)
    {
        handleArray = IntPtr.Zero;
        IntPtr[] candidates = new IntPtr[] { si.hStdInput, si.hStdOutput, si.hStdError };
        System.Collections.Generic.List<IntPtr> handles = new System.Collections.Generic.List<IntPtr>();
        foreach (IntPtr h in candidates)
        {
            if (h != IntPtr.Zero && h != Native.INVALID_HANDLE_VALUE && !handles.Contains(h))
            {
                handles.Add(h);
            }
        }
        if (handles.Count == 0)
        {
            return IntPtr.Zero;
        }

        IntPtr size = IntPtr.Zero;
        Native.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        if (size == IntPtr.Zero)
        {
            return IntPtr.Zero;
        }
        IntPtr list = Marshal.AllocHGlobal(size);
        if (!Native.InitializeProcThreadAttributeList(list, 1, 0, ref size))
        {
            Marshal.FreeHGlobal(list);
            return IntPtr.Zero;
        }
        handleArray = Marshal.AllocHGlobal(IntPtr.Size * handles.Count);
        for (int i = 0; i < handles.Count; i++)
        {
            Marshal.WriteIntPtr(handleArray, i * IntPtr.Size, handles[i]);
        }
        if (!Native.UpdateProcThreadAttribute(list, 0, (IntPtr)Native.PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                handleArray, (IntPtr)(IntPtr.Size * handles.Count), IntPtr.Zero, IntPtr.Zero))
        {
            Native.DeleteProcThreadAttributeList(list);
            Marshal.FreeHGlobal(list);
            Marshal.FreeHGlobal(handleArray);
            handleArray = IntPtr.Zero;
            return IntPtr.Zero;
        }
        return list;
    }

    private static void FreeHandleList(IntPtr list, IntPtr handleArray)
    {
        if (list != IntPtr.Zero)
        {
            Native.DeleteProcThreadAttributeList(list);
            Marshal.FreeHGlobal(list);
        }
        if (handleArray != IntPtr.Zero)
        {
            Marshal.FreeHGlobal(handleArray);
        }
    }

    private static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = Native.CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            return IntPtr.Zero;
        }
        Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags =
            Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | Native.JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
        int size = Marshal.SizeOf(typeof(Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, buffer, false);
            if (!Native.SetInformationJobObject(job, Native.JobObjectExtendedLimitInformation, buffer, (uint)size))
            {
                Log("could not configure the job (error " + Marshal.GetLastWin32Error() + ")");
                Native.CloseHandle(job);
                return IntPtr.Zero;
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        return job;
    }

    private static IntPtr Inheritable(IntPtr handle)
    {
        if (handle != IntPtr.Zero && handle != Native.INVALID_HANDLE_VALUE)
        {
            // Fails harmlessly for console pseudo-handles, which are inherited anyway.
            Native.SetHandleInformation(handle, Native.HANDLE_FLAG_INHERIT, Native.HANDLE_FLAG_INHERIT);
        }
        return handle;
    }

    private static string WriteSessionRecord(int claudePid, string cwd, string loginFolder)
    {
        try
        {
            if (root == null)
            {
                return null;
            }
            string dir = Path.Combine(root, "sessions");
            Directory.CreateDirectory(dir);
            int self = Process.GetCurrentProcess().Id;
            string path = Path.Combine(dir, self + ".json");
            StringBuilder json = new StringBuilder();
            json.Append("{\"launcherPid\":").Append(self)
                .Append(",\"hostPid\":").Append(ParentProcessId(self))
                .Append(",\"claudePid\":").Append(claudePid)
                .Append(",\"cwd\":").Append(JsonString(cwd))
                .Append(",\"loginFolder\":").Append(loginFolder == null ? "null" : JsonString(loginFolder))
                .Append(",\"startedAt\":").Append(JsonString(DateTime.UtcNow.ToString("o")))
                .Append("}");
            string temp = path + ".tmp";
            File.WriteAllText(temp, json.ToString(), new UTF8Encoding(false));
            if (File.Exists(path))
            {
                File.Delete(path);
            }
            File.Move(temp, path);
            return path;
        }
        catch (Exception e)
        {
            Log("could not record the session: " + e.Message);
            return null;
        }
    }

    /// <summary>The process that started us: the extension host of one VS Code window.</summary>
    private static int ParentProcessId(int pid)
    {
        IntPtr snapshot = Native.CreateToolhelp32Snapshot(Native.TH32CS_SNAPPROCESS, 0);
        if (snapshot == Native.INVALID_HANDLE_VALUE)
        {
            return 0;
        }
        try
        {
            Native.PROCESSENTRY32 entry = new Native.PROCESSENTRY32();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(Native.PROCESSENTRY32));
            if (!Native.Process32First(snapshot, ref entry))
            {
                return 0;
            }
            do
            {
                if (entry.th32ProcessID == (uint)pid)
                {
                    return (int)entry.th32ParentProcessID;
                }
            } while (Native.Process32Next(snapshot, ref entry));
            return 0;
        }
        finally
        {
            Native.CloseHandle(snapshot);
        }
    }

    private static string JsonString(string value)
    {
        StringBuilder sb = new StringBuilder("\"");
        foreach (char c in value)
        {
            if (c == '"' || c == '\\')
            {
                sb.Append('\\').Append(c);
            }
            else if (c < ' ')
            {
                sb.Append("\\u").Append(((int)c).ToString("x4"));
            }
            else
            {
                sb.Append(c);
            }
        }
        return sb.Append('"').ToString();
    }

    private static string SafeCurrentDirectory()
    {
        try
        {
            return Environment.CurrentDirectory;
        }
        catch
        {
            return null;
        }
    }

    private static void DeleteQuietly(string path)
    {
        if (path == null)
        {
            return;
        }
        try
        {
            File.Delete(path);
        }
        catch
        {
        }
    }

    private static void Log(string message)
    {
        try
        {
            if (root == null)
            {
                return;
            }
            string path = Path.Combine(root, "launcher.log");
            FileInfo info = new FileInfo(path);
            if (info.Exists && info.Length > 256 * 1024)
            {
                File.Copy(path, path + ".old", true);
                File.Delete(path);
            }
            File.AppendAllText(path,
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " [" + Process.GetCurrentProcess().Id + "] " +
                message + Environment.NewLine,
                new UTF8Encoding(false));
        }
        catch
        {
            // Several launchers can append at once; a lost log line is not worth failing over.
        }
    }
}

internal static class Native
{
    public const uint INFINITE = 0xFFFFFFFF;
    public const int STD_INPUT_HANDLE = -10;
    public const int STD_OUTPUT_HANDLE = -11;
    public const int STD_ERROR_HANDLE = -12;
    public const int STARTF_USESTDHANDLES = 0x00000100;
    public const uint CREATE_SUSPENDED = 0x00000004;
    public const uint CREATE_NO_WINDOW = 0x08000000;
    public const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    public const int PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
    public const uint HANDLE_FLAG_INHERIT = 0x00000001;
    public const int JobObjectExtendedLimitInformation = 9;
    public const uint JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = 0x00001000;
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    public const uint TH32CS_SNAPPROCESS = 0x00000002;
    public static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcess(string lpApplicationName, StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags,
        IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFOEX lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount,
        int dwFlags, ref IntPtr lpSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr attribute,
        IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetConsoleWindow();

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCommandLineW();

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpInfo, uint cbInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "Process32FirstW")]
    public static extern bool Process32First(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "Process32NextW")]
    public static extern bool Process32Next(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);
}
