package auth

import (
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

const (
	AudienceUser  = "designkit-user"
	AudienceAdmin = "designkit-admin"
)

type Claims struct {
	UserID      uuid.UUID `json:"uid"`
	WorkspaceID uuid.UUID `json:"ws,omitempty"`
	Role        string    `json:"role,omitempty"`
	Plan        string    `json:"plan,omitempty"`
	Admin       bool      `json:"adm,omitempty"`
	jwt.RegisteredClaims
}

type Manager struct {
	secret []byte
	ttl    time.Duration
}

func NewManager(secret string, ttl time.Duration) *Manager {
	return &Manager{secret: []byte(secret), ttl: ttl}
}

func (m *Manager) IssueUser(userID, workspaceID uuid.UUID, role, plan string, admin bool) (string, error) {
	aud := AudienceUser
	if admin {
		aud = AudienceAdmin
	}
	claims := Claims{
		UserID:      userID,
		WorkspaceID: workspaceID,
		Role:        role,
		Plan:        plan,
		Admin:       admin,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID.String(),
			Audience:  jwt.ClaimStrings{aud},
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(m.ttl)),
			Issuer:    "designkit",
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(m.secret)
}

var ErrInvalidToken = errors.New("invalid token")

func (m *Manager) Parse(tokenString, audience string) (*Claims, error) {
	tok, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(t *jwt.Token) (any, error) {
		if t.Method.Alg() != jwt.SigningMethodHS256.Alg() {
			return nil, ErrInvalidToken
		}
		return m.secret, nil
	}, jwt.WithAudience(audience), jwt.WithIssuer("designkit"))
	if err != nil {
		return nil, ErrInvalidToken
	}
	claims, ok := tok.Claims.(*Claims)
	if !ok || !tok.Valid {
		return nil, ErrInvalidToken
	}
	return claims, nil
}
