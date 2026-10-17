package main

import (
	"os"
	"syscall"
)

func statVersion(path string) (fileVersion, error) {
	info, err := os.Stat(path)
	if err != nil {
		return fileVersion{}, err
	}
	stat := info.Sys().(*syscall.Stat_t)
	return fileVersion{int64(stat.Dev), int64(stat.Ino), float64(stat.Birthtimespec.Sec)*1000 + float64(stat.Birthtimespec.Nsec)/1e6, info.Size(), float64(stat.Mtimespec.Sec)*1000 + float64(stat.Mtimespec.Nsec)/1e6, float64(stat.Ctimespec.Sec)*1000 + float64(stat.Ctimespec.Nsec)/1e6}, nil
}
