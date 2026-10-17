package main

import (
	"golang.org/x/sys/windows"
	"unsafe"
)

func statVersion(path string) (fileVersion, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return fileVersion{}, err
	}
	handle, err := windows.CreateFile(name, windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return fileVersion{}, err
	}
	defer windows.CloseHandle(handle)
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return fileVersion{}, err
	}
	// libuv 使用 FILE_BASIC_INFO 的 ChangeTime，而不是最后访问时间。
	var basic struct {
		CreationTime, LastAccessTime, LastWriteTime, ChangeTime int64
		FileAttributes                                          uint32
	}
	if err := windows.GetFileInformationByHandleEx(handle, windows.FileBasicInfo, (*byte)(unsafe.Pointer(&basic)), uint32(unsafe.Sizeof(basic))); err != nil {
		return fileVersion{}, err
	}
	return fileVersion{Dev: int64(info.VolumeSerialNumber), Ino: int64(uint64(info.FileIndexHigh)<<32 | uint64(info.FileIndexLow)), Birth: windowsMillis(basic.CreationTime), Size: int64(uint64(info.FileSizeHigh)<<32 | uint64(info.FileSizeLow)), Mtime: windowsMillis(basic.LastWriteTime), Ctime: windowsMillis(basic.ChangeTime)}, nil
}

func windowsMillis(ticks int64) float64 {
	ticks -= 116444736000000000
	return float64(ticks/10000000)*1000 + float64(ticks%10000000)/10000
}
