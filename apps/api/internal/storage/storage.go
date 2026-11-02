package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

var ErrInvalidKey = errors.New("invalid storage key")

// Store 抽象对象存储，本地实现用于开发，后续替换为 S3/R2。
type Store interface {
	Save(ctx context.Context, key string, r io.Reader) (int64, error)
	Open(ctx context.Context, key string) (io.ReadCloser, error)
	Delete(ctx context.Context, key string) error
	Path(key string) string
}

type Local struct {
	Root string
}

func NewLocal(root string) (*Local, error) {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	return &Local{Root: abs}, nil
}

func (l *Local) resolve(key string) (string, error) {
	if key == "" || strings.Contains(key, "..") || strings.HasPrefix(key, "/") {
		return "", ErrInvalidKey
	}
	full := filepath.Join(l.Root, filepath.FromSlash(key))
	rel, err := filepath.Rel(l.Root, full)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", ErrInvalidKey
	}
	return full, nil
}

func (l *Local) Save(_ context.Context, key string, r io.Reader) (int64, error) {
	full, err := l.resolve(key)
	if err != nil {
		return 0, err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return 0, err
	}
	f, err := os.Create(full)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	n, err := io.Copy(f, r)
	if err != nil {
		return n, fmt.Errorf("write object: %w", err)
	}
	return n, nil
}

func (l *Local) Open(_ context.Context, key string) (io.ReadCloser, error) {
	full, err := l.resolve(key)
	if err != nil {
		return nil, err
	}
	return os.Open(full)
}

func (l *Local) Delete(_ context.Context, key string) error {
	full, err := l.resolve(key)
	if err != nil {
		return err
	}
	return os.Remove(full)
}

func (l *Local) Path(key string) string {
	full, err := l.resolve(key)
	if err != nil {
		return ""
	}
	return full
}
