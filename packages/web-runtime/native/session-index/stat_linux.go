package main

import (
	"errors"
	"golang.org/x/sys/unix"
	"os"
	"syscall"
)

func statVersion(path string) (fileVersion, error) {
	info, err := os.Stat(path)
	if err != nil {
		return fileVersion{}, err
	}
	stat := info.Sys().(*syscall.Stat_t)
	// Unknown birth time stays zero; ctime changes on append and is not an identity.
	var birth float64
	var extended unix.Statx_t
	err = unix.Statx(unix.AT_FDCWD, path, 0, unix.STATX_BTIME, &extended)
	if err == nil && extended.Mask&unix.STATX_BTIME != 0 {
		birth = float64(extended.Btime.Sec)*1000 + float64(extended.Btime.Nsec)/1e6
	} else if err != nil && !errors.Is(err, unix.ENOSYS) && !errors.Is(err, unix.EINVAL) && !errors.Is(err, unix.EOPNOTSUPP) {
		return fileVersion{}, err
	}
	return fileVersion{int64(stat.Dev), int64(stat.Ino), birth, info.Size(), float64(stat.Mtim.Sec)*1000 + float64(stat.Mtim.Nsec)/1e6, float64(stat.Ctim.Sec)*1000 + float64(stat.Ctim.Nsec)/1e6}, nil
}
